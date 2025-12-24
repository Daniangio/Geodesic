"""
In-memory guest token manager.
"""

import asyncio
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

TOKEN_TTL_SECONDS = 60 * 60 * 24


@dataclass
class TokenInfo:
    token: str
    issued_at: datetime
    expires_at: datetime
    member_id: Optional[str] = None


class AuthManager:
    def __init__(self) -> None:
        self._tokens: Dict[str, TokenInfo] = {}
        self._lock = asyncio.Lock()

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    async def issue_guest_token(self) -> TokenInfo:
        token = secrets.token_urlsafe(32)
        now = self._now()
        info = TokenInfo(
            token=token,
            issued_at=now,
            expires_at=now + timedelta(seconds=TOKEN_TTL_SECONDS),
        )
        async with self._lock:
            self._tokens[token] = info
        return info

    async def claim_token(self, token: str, member_id: str) -> Optional[TokenInfo]:
        if not token:
            return None
        now = self._now()
        async with self._lock:
            info = self._tokens.get(token)
            if not info:
                return None
            if info.expires_at <= now:
                self._tokens.pop(token, None)
                return None
            if info.member_id is not None:
                return None
            info.member_id = member_id
            return info

    async def revoke_token(self, token: Optional[str]) -> None:
        if not token:
            return
        async with self._lock:
            self._tokens.pop(token, None)


auth_manager = AuthManager()
