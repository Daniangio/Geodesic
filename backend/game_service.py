"""In-memory game service to coordinate game sessions."""

import asyncio
from typing import Dict, List, Optional

from geodesic.engine import GameEngine
from geodesic.errors import GameRuleError


class GameService:
    def __init__(self) -> None:
        self._games: Dict[str, GameEngine] = {}
        self._lock = asyncio.Lock()

    async def create_game(self, room_id: str, players: List[Dict[str, str]]) -> GameEngine:
        async with self._lock:
            engine = GameEngine(room_id=room_id, players=players)
            self._games[engine.state.game_id] = engine
            return engine

    async def get_game(self, game_id: str) -> Optional[GameEngine]:
        async with self._lock:
            return self._games.get(game_id)

    async def remove_game(self, game_id: str) -> None:
        async with self._lock:
            self._games.pop(game_id, None)

    async def apply_action(
        self, game_id: str, player_id: str, action: str, payload: Dict[str, object]
    ) -> GameEngine:
        async with self._lock:
            engine = self._games.get(game_id)
            if not engine:
                raise GameRuleError("Game not found.")
            engine.apply_action(player_id, action, payload)
            return engine


game_service = GameService()
