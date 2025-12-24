"""
In-memory lobby state for guest presence.
"""

import asyncio
import secrets
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple
from uuid import uuid4

from fastapi import WebSocket

from backend.game_service import game_service

MAX_NAME_LENGTH = 24
MAX_ROOM_NAME_LENGTH = 32
ROOM_ID_LENGTH = 6


def guest_name() -> str:
    tag = secrets.token_hex(2).upper()
    return f"Guest {tag}"


def sanitize_guest_name(raw_name: Optional[str]) -> str:
    if not raw_name:
        return guest_name()
    cleaned = raw_name.strip()
    if not cleaned:
        return guest_name()
    if len(cleaned) > MAX_NAME_LENGTH:
        cleaned = cleaned[:MAX_NAME_LENGTH].rstrip()
    return cleaned


@dataclass
class LobbyMember:
    member_id: str
    name: str
    joined_at: str

    def to_dict(self) -> Dict[str, str]:
        return asdict(self)


@dataclass
class LobbyRoom:
    room_id: str
    name: str
    host_id: str
    created_at: str
    started: bool
    members: List[str]
    game_id: Optional[str] = None

    def to_dict(self, members: Dict[str, LobbyMember]) -> Dict[str, object]:
        member_list = []
        for member_id in self.members:
            member = members.get(member_id)
            if member:
                member_list.append(member.to_dict())
        host = members.get(self.host_id)
        return {
            "room_id": self.room_id,
            "name": self.name,
            "host_id": self.host_id,
            "host_name": host.name if host else None,
            "created_at": self.created_at,
            "started": self.started,
            "members": member_list,
            "game_id": self.game_id,
        }


class LobbyManager:
    def __init__(self) -> None:
        self._members: Dict[str, LobbyMember] = {}
        self._connections: Dict[str, WebSocket] = {}
        self._rooms: Dict[str, LobbyRoom] = {}
        self._member_room: Dict[str, str] = {}
        self._lock = asyncio.Lock()

    def snapshot(self) -> List[Dict[str, str]]:
        return [member.to_dict() for member in self._members.values()]

    def rooms_snapshot(self) -> List[Dict[str, object]]:
        return [room.to_dict(self._members) for room in self._rooms.values()]

    async def connect(
        self, websocket: WebSocket, requested_name: Optional[str], member_id: Optional[str] = None
    ) -> LobbyMember:
        await websocket.accept()
        member = LobbyMember(
            member_id=member_id or str(uuid4()),
            name=sanitize_guest_name(requested_name),
            joined_at=datetime.now(timezone.utc).isoformat(),
        )
        async with self._lock:
            self._members[member.member_id] = member
            self._connections[member.member_id] = websocket
            members_snapshot = self.snapshot()
            rooms_snapshot = self.rooms_snapshot()
        await websocket.send_json(
            {
                "type": "welcome",
                "member": member.to_dict(),
                "members": members_snapshot,
                "rooms": rooms_snapshot,
            }
        )
        await self._broadcast({"type": "member_joined", "member": member.to_dict()}, exclude={member.member_id})
        return member

    async def disconnect(self, member_id: str) -> None:
        room_changed = False
        async with self._lock:
            member = self._members.pop(member_id, None)
            self._connections.pop(member_id, None)
            if member_id in self._member_room:
                room_changed = self._remove_member_from_room_locked(member_id)
        if member:
            await self._broadcast({"type": "member_left", "member": member.to_dict()})
        if room_changed:
            await self._broadcast_rooms()

    async def rename(self, member_id: str, new_name: Optional[str]) -> Optional[LobbyMember]:
        name = sanitize_guest_name(new_name)
        should_refresh_rooms = False
        async with self._lock:
            member = self._members.get(member_id)
            if not member:
                return None
            member.name = name
            updated = member.to_dict()
            should_refresh_rooms = member_id in self._member_room
        await self._broadcast({"type": "member_renamed", "member": updated})
        if should_refresh_rooms:
            await self._broadcast_rooms()
        return member

    async def create_room(self, member_id: str, raw_name: Optional[str]) -> Tuple[bool, str]:
        name = self._sanitize_room_name(raw_name)
        async with self._lock:
            if member_id not in self._members:
                return False, "Member not found."
            if member_id in self._member_room:
                self._remove_member_from_room_locked(member_id)
            room_id = self._generate_room_id()
            room = LobbyRoom(
                room_id=room_id,
                name=name,
                host_id=member_id,
                created_at=datetime.now(timezone.utc).isoformat(),
                started=False,
                members=[member_id],
                game_id=None,
            )
            self._rooms[room_id] = room
            self._member_room[member_id] = room_id
        await self._broadcast_rooms()
        return True, room_id

    async def join_room(self, member_id: str, room_id: Optional[str]) -> Tuple[bool, str]:
        if not room_id:
            return False, "Room id is required."
        target_room = None
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return False, "Room not found."
            if member_id not in self._members:
                return False, "Member not found."
            if member_id in self._member_room and self._member_room[member_id] == room_id:
                return True, room_id
            if member_id in self._member_room:
                self._remove_member_from_room_locked(member_id)
            if member_id not in room.members:
                room.members.append(member_id)
            self._member_room[member_id] = room_id
            target_room = room
        await self._broadcast_rooms()
        if target_room and target_room.game_id:
            engine = await game_service.get_game(target_room.game_id)
            if engine:
                await self._broadcast_to_members(
                    [member_id],
                    lambda mid: {"type": "game_state", "state": engine.serialize_state(mid)},
                )
        return True, room_id

    async def leave_room(self, member_id: str) -> bool:
        changed = False
        async with self._lock:
            changed = self._remove_member_from_room_locked(member_id)
        if changed:
            await self._broadcast_rooms()
        return changed

    async def start_game(self, member_id: str, room_id: Optional[str]) -> Tuple[bool, str]:
        if not room_id:
            return False, "Room id is required."
        member_payloads = []
        engine = None
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return False, "Room not found."
            if room.host_id != member_id:
                return False, "Only the host can start the game."
            if room.started:
                return False, "Game already started."
            member_payloads = [
                self._members[mid].to_dict()
                for mid in room.members
                if mid in self._members
            ]
        if not member_payloads:
            return False, "No players in room."
        engine = await game_service.create_game(room_id, member_payloads)
        async with self._lock:
            room = self._rooms.get(room_id)
            if room:
                room.started = True
                room.game_id = engine.state.game_id
        await self._broadcast_rooms()
        await self._broadcast_game_state(room_id, engine, event_type="game_started")
        return True, room_id

    async def _broadcast(self, payload: Dict[str, object], exclude: Optional[Set[str]] = None) -> None:
        exclude = exclude or set()
        async with self._lock:
            targets = [
                (member_id, websocket)
                for member_id, websocket in self._connections.items()
                if member_id not in exclude
            ]
        stale: List[str] = []
        for member_id, websocket in targets:
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(member_id)
        if stale:
            async with self._lock:
                for member_id in stale:
                    self._connections.pop(member_id, None)
                    self._members.pop(member_id, None)
                    self._remove_member_from_room_locked(member_id)

    async def _broadcast_rooms(self) -> None:
        await self._broadcast({"type": "rooms_updated", "rooms": self.rooms_snapshot()})

    async def _broadcast_game_state(self, room_id: str, engine, event_type: str = "game_state") -> None:
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return
            member_ids = list(room.members)
        await self._broadcast_to_members(
            member_ids,
            lambda member_id: {
                "type": event_type,
                "state": engine.serialize_state(member_id),
            },
        )

    async def broadcast_game_update(self, room_id: str, engine) -> None:
        await self._broadcast_game_state(room_id, engine, event_type="game_state")

    async def _broadcast_to_members(self, member_ids: List[str], payload_fn) -> None:
        stale: List[str] = []
        async with self._lock:
            targets = [(mid, self._connections.get(mid)) for mid in member_ids]
        for member_id, websocket in targets:
            if not websocket:
                continue
            try:
                await websocket.send_json(payload_fn(member_id))
            except Exception:
                stale.append(member_id)
        if stale:
            async with self._lock:
                for member_id in stale:
                    self._connections.pop(member_id, None)
                    self._members.pop(member_id, None)
                    self._remove_member_from_room_locked(member_id)

    def _remove_member_from_room_locked(self, member_id: str) -> bool:
        room_id = self._member_room.pop(member_id, None)
        if not room_id:
            return False
        room = self._rooms.get(room_id)
        if not room:
            return False
        if member_id in room.members:
            room.members = [mid for mid in room.members if mid != member_id]
        if not room.members:
            if room.game_id:
                try:
                    asyncio.create_task(game_service.remove_game(room.game_id))
                except Exception:
                    pass
            self._rooms.pop(room_id, None)
            return True
        if room.host_id == member_id:
            room.host_id = room.members[0]
        return True

    def get_room_id_for_member(self, member_id: str) -> Optional[str]:
        return self._member_room.get(member_id)

    def get_room(self, room_id: str) -> Optional[LobbyRoom]:
        return self._rooms.get(room_id)

    def _sanitize_room_name(self, raw_name: Optional[str]) -> str:
        if not raw_name:
            return "New Room"
        cleaned = raw_name.strip()
        if not cleaned:
            return "New Room"
        if len(cleaned) > MAX_ROOM_NAME_LENGTH:
            cleaned = cleaned[:MAX_ROOM_NAME_LENGTH].rstrip()
        return cleaned

    def _generate_room_id(self) -> str:
        while True:
            room_id = secrets.token_hex(ROOM_ID_LENGTH // 2).upper()
            if room_id not in self._rooms:
                return room_id


lobby_manager = LobbyManager()
