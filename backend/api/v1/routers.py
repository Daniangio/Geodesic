"""
API Router for lobby presence.
"""

import asyncio
import json
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.api.v1.schemas import GuestAuthRequest, GuestAuthResponse, LobbyState
from backend.auth import auth_manager
from backend.lobby import lobby_manager, sanitize_guest_name
from backend.game_service import game_service
from geodesic.errors import GameRuleError

api_router = APIRouter()


@api_router.post("/auth/guest", response_model=GuestAuthResponse, tags=["Auth"])
async def create_guest_token(payload: GuestAuthRequest):
    token_info = await auth_manager.issue_guest_token()
    display_name = sanitize_guest_name(payload.name)
    return {
        "token": token_info.token,
        "expires_at": token_info.expires_at.isoformat(),
        "name": display_name,
    }


@api_router.get("/lobby", response_model=LobbyState, tags=["Lobby"])
async def get_lobby_state():
    members = lobby_manager.snapshot()
    rooms = lobby_manager.rooms_snapshot()
    return {"members": members, "rooms": rooms, "count": len(members)}


@api_router.websocket("/lobby/ws")
async def lobby_ws(websocket: WebSocket, name: Optional[str] = None, token: Optional[str] = None):
    if not token:
        await websocket.close(code=1008)
        return
    member_id = str(uuid4())
    token_info = await auth_manager.claim_token(token, member_id)
    if not token_info:
        await websocket.close(code=1008)
        return
    member = None
    try:
        member = await lobby_manager.connect(websocket, name, member_id=member_id)
        while True:
            timeout = (token_info.expires_at - datetime.now(timezone.utc)).total_seconds()
            if timeout <= 0:
                await websocket.close(code=1000)
                break
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=timeout)
            except asyncio.TimeoutError:
                await websocket.close(code=1000)
                break
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            message_type = payload.get("type")
            if message_type == "rename":
                await lobby_manager.rename(member.member_id, payload.get("name"))
            elif message_type == "ping":
                await websocket.send_json({"type": "pong"})
            elif message_type == "create_room":
                ok, info = await lobby_manager.create_room(member.member_id, payload.get("name"))
                if not ok:
                    await websocket.send_json({"type": "error", "message": info})
            elif message_type == "join_room":
                ok, info = await lobby_manager.join_room(member.member_id, payload.get("room_id"))
                if not ok:
                    await websocket.send_json({"type": "error", "message": info})
            elif message_type == "leave_room":
                await lobby_manager.leave_room(member.member_id)
            elif message_type == "start_game":
                ok, info = await lobby_manager.start_game(member.member_id, payload.get("room_id"))
                if not ok:
                    await websocket.send_json({"type": "error", "message": info})
            elif message_type == "game_action":
                room_id = lobby_manager.get_room_id_for_member(member.member_id)
                if not room_id:
                    await websocket.send_json({"type": "game_error", "message": "You are not in a room."})
                    continue
                room = lobby_manager.get_room(room_id)
                if not room or not room.game_id:
                    await websocket.send_json({"type": "game_error", "message": "No active game."})
                    continue
                action = payload.get("action")
                action_payload = payload.get("payload") or {}
                try:
                    engine = await game_service.apply_action(room.game_id, member.member_id, action, action_payload)
                except GameRuleError as exc:
                    await websocket.send_json({"type": "game_error", "message": str(exc)})
                    continue
                await lobby_manager.broadcast_game_update(room_id, engine)
    except WebSocketDisconnect:
        pass
    finally:
        if member:
            await lobby_manager.disconnect(member.member_id)
        await auth_manager.revoke_token(token)
