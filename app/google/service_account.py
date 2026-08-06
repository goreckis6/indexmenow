from __future__ import annotations

import json
from typing import Any

import httpx
from google.auth.transport import Request as BaseRequest
from google.auth.transport import Response as BaseResponse
from google.oauth2 import service_account as gsa

from app.google.errors import GoogleApiError

INDEXING_SCOPE = "https://www.googleapis.com/auth/indexing"
WEBMASTERS_SCOPE = "https://www.googleapis.com/auth/webmasters"


class _HttpxResponse(BaseResponse):
    """Adapts an httpx response to the interface google-auth expects."""

    def __init__(self, response: httpx.Response):
        self._response = response

    @property
    def status(self) -> int:
        return self._response.status_code

    @property
    def headers(self) -> dict:
        return dict(self._response.headers)

    @property
    def data(self) -> bytes:
        return self._response.content


class HttpxRequest(BaseRequest):
    """google-auth transport backed by httpx, so `requests` is not needed."""

    def __call__(self, url, method="GET", body=None, headers=None, timeout=30, **kwargs):
        with httpx.Client(timeout=timeout or 30, follow_redirects=True) as client:
            response = client.request(method, url, content=body, headers=headers)
        return _HttpxResponse(response)


def parse_service_account_json(raw: str | bytes) -> dict[str, Any]:
    try:
        info = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise GoogleApiError("Plik nie jest poprawnym JSON-em konta serwisowego.") from exc

    if info.get("type") != "service_account":
        raise GoogleApiError('Plik JSON musi miec pole "type": "service_account".')
    for field in ("client_email", "private_key"):
        if not info.get(field):
            raise GoogleApiError(f"Brak pola '{field}' w pliku konta serwisowego.")
    return info


def build_credentials(info: dict[str, Any], scopes: list[str] | None = None):
    try:
        return gsa.Credentials.from_service_account_info(
            info, scopes=scopes or [INDEXING_SCOPE, WEBMASTERS_SCOPE]
        )
    except Exception as exc:  # noqa: BLE001 - google raises many types
        raise GoogleApiError(f"Nieprawidlowy klucz konta serwisowego: {exc}") from exc


def get_service_account_token(info: dict[str, Any], scopes: list[str] | None = None) -> str:
    credentials = build_credentials(info, scopes)
    try:
        credentials.refresh(HttpxRequest())
    except Exception as exc:  # noqa: BLE001
        raise GoogleApiError(f"Nie udalo sie pobrac tokena konta serwisowego: {exc}") from exc
    return credentials.token


def credentials_info(client_email: str, private_key: str, project_id: str | None = None) -> dict:
    """Rebuild the minimal payload required to sign a JWT."""
    return {
        "type": "service_account",
        "client_email": client_email,
        "private_key": private_key,
        "token_uri": "https://oauth2.googleapis.com/token",
        "project_id": project_id or "",
    }
