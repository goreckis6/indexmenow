from __future__ import annotations

import secrets

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

_fernet = Fernet(settings.fernet_key)


def encrypt(value: str | None) -> str | None:
    if value is None:
        return None
    return _fernet.encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _fernet.decrypt(value.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return None


def generate_indexnow_key() -> str:
    """IndexNow keys must be 8-128 hex-ish characters."""
    return secrets.token_hex(16)


def generate_state() -> str:
    return secrets.token_urlsafe(24)
