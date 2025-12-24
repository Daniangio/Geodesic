"""
Pydantic schemas for lobby endpoints.
"""

from pydantic import BaseModel


class LobbyMember(BaseModel):
    member_id: str
    name: str
    joined_at: str


class LobbyRoom(BaseModel):
    room_id: str
    name: str
    host_id: str
    host_name: str | None = None
    created_at: str
    started: bool
    members: list[LobbyMember]
    game_id: str | None = None


class LobbyState(BaseModel):
    members: list[LobbyMember]
    rooms: list[LobbyRoom]
    count: int


class GuestAuthRequest(BaseModel):
    name: str | None = None


class GuestAuthResponse(BaseModel):
    token: str
    expires_at: str
    name: str
