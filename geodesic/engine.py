"""
Minimal game engine stub.

This keeps the lobby flow working without the full game rules.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional
from uuid import uuid4


@dataclass
class TurnState:
    number: int
    player_id: str
    has_taken_action: bool = False
    has_played_land: bool = False


@dataclass
class PlayerState:
    member_id: str
    name: str
    score: int = 0
    hand_count: int = 0
    lands_in_play: List[Dict[str, str]] = field(default_factory=list)
    gifts: List[Dict[str, object]] = field(default_factory=list)
    building: Optional[str] = None

    def serialize_public(self) -> Dict[str, object]:
        return {
            "member_id": self.member_id,
            "name": self.name,
            "score": self.score,
            "hand_count": self.hand_count,
            "lands_in_play": list(self.lands_in_play),
            "gifts": list(self.gifts),
            "building": self.building,
        }

    def serialize_viewer(self) -> Dict[str, object]:
        return {
            "member_id": self.member_id,
            "name": self.name,
            "hand": [],
            "lands_in_play": list(self.lands_in_play),
            "building": self.building,
            "pending_discard": 0,
        }


@dataclass
class GameState:
    game_id: str
    room_id: str
    players: List[PlayerState]
    turn: TurnState
    gifts_display: List[Dict[str, object]] = field(default_factory=list)


class GameEngine:
    def __init__(self, room_id: str, players: List[Dict[str, str]]) -> None:
        player_states = [
            PlayerState(member_id=player["member_id"], name=player["name"])
            for player in players
        ]
        first_player_id = player_states[0].member_id if player_states else "unknown"
        self.state = GameState(
            game_id=uuid4().hex,
            room_id=room_id,
            players=player_states,
            turn=TurnState(number=1, player_id=first_player_id),
        )

    def apply_action(self, player_id: str, action: str, payload: Dict[str, object]) -> None:
        # Stub: no-op actions so the lobby flow doesn't crash.
        return

    def serialize_state(self, viewer_id: str) -> Dict[str, object]:
        viewer = next(
            (player for player in self.state.players if player.member_id == viewer_id),
            None,
        )
        if viewer is None and self.state.players:
            viewer = self.state.players[0]
        return {
            "game_id": self.state.game_id,
            "room_id": self.state.room_id,
            "players": [player.serialize_public() for player in self.state.players],
            "viewer": viewer.serialize_viewer() if viewer else {},
            "turn": {
                "number": self.state.turn.number,
                "player_id": self.state.turn.player_id,
                "has_taken_action": self.state.turn.has_taken_action,
                "has_played_land": self.state.turn.has_played_land,
            },
            "gifts_display": list(self.state.gifts_display),
        }
