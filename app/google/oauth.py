from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.google.errors import GoogleApiError, parse_error
from app.models import GoogleCredential, User
from app.security import decrypt, encrypt

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"
REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke"

SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/webmasters",
    "https://www.googleapis.com/auth/indexing",
]


def build_authorization_url(state: str, login_hint: str | None = None) -> str:
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "include_granted_scopes": "true",
        "prompt": "consent select_account",
        "state": state,
    }
    if login_hint:
        params["login_hint"] = login_hint
    return f"{AUTH_ENDPOINT}?{urlencode(params)}"


def exchange_code(code: str) -> dict:
    data = {
        "code": code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": settings.redirect_uri,
        "grant_type": "authorization_code",
    }
    with httpx.Client(timeout=30) as client:
        response = client.post(TOKEN_ENDPOINT, data=data)
    if response.status_code >= 400:
        raise parse_error(response.status_code, _safe_json(response))
    return response.json()


def refresh_access_token(refresh_token: str) -> dict:
    data = {
        "refresh_token": refresh_token,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "grant_type": "refresh_token",
    }
    with httpx.Client(timeout=30) as client:
        response = client.post(TOKEN_ENDPOINT, data=data)
    if response.status_code >= 400:
        raise parse_error(response.status_code, _safe_json(response))
    return response.json()


def fetch_userinfo(access_token: str) -> dict:
    with httpx.Client(timeout=30) as client:
        response = client.get(
            USERINFO_ENDPOINT, headers={"Authorization": f"Bearer {access_token}"}
        )
    if response.status_code >= 400:
        raise parse_error(response.status_code, _safe_json(response))
    return response.json()


def revoke_token(token: str) -> None:
    try:
        with httpx.Client(timeout=15) as client:
            client.post(REVOKE_ENDPOINT, data={"token": token})
    except httpx.HTTPError:
        pass


def store_credentials(db: Session, user: User, token_data: dict) -> GoogleCredential:
    expires_in = int(token_data.get("expires_in", 3600))
    expires_at = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=expires_in)

    credential = user.credential
    if credential is None:
        credential = GoogleCredential(user_id=user.id)
        db.add(credential)

    credential.access_token_enc = encrypt(token_data["access_token"])
    if token_data.get("refresh_token"):
        credential.refresh_token_enc = encrypt(token_data["refresh_token"])
    credential.token_type = token_data.get("token_type", "Bearer")
    credential.scopes = token_data.get("scope", " ".join(SCOPES))
    credential.expires_at = expires_at
    credential.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.flush()
    return credential


def get_access_token(db: Session, user: User) -> str:
    """Return a valid access token, refreshing it when required."""
    credential = user.credential
    if credential is None:
        raise GoogleApiError(
            "Brak polaczenia z kontem Google. Zaloguj sie ponownie.", status_code=401
        )

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    token = decrypt(credential.access_token_enc)
    fresh_enough = credential.expires_at and credential.expires_at - timedelta(seconds=90) > now

    if token and fresh_enough:
        return token

    refresh_token = decrypt(credential.refresh_token_enc)
    if not refresh_token:
        if token:
            return token
        raise GoogleApiError(
            "Token wygasl i brak refresh tokena. Wyloguj sie i zaloguj ponownie.",
            status_code=401,
        )

    data = refresh_access_token(refresh_token)
    data.setdefault("refresh_token", refresh_token)
    credential = store_credentials(db, user, data)
    db.commit()
    return decrypt(credential.access_token_enc) or data["access_token"]


def has_scope(user: User, scope: str) -> bool:
    if user.credential is None:
        return False
    return scope in user.credential.scope_list


def _safe_json(response: httpx.Response) -> dict | str:
    try:
        return response.json()
    except ValueError:
        return response.text
