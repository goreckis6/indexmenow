from __future__ import annotations

import httpx

from app.google.errors import GoogleApiError, parse_error

PUBLISH_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications:publish"
METADATA_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications/metadata"

TIMEOUT = httpx.Timeout(45.0, connect=15.0)


def publish_url(access_token: str, url: str, notification_type: str = "URL_UPDATED") -> dict:
    """Notify Google that a URL was updated or deleted.

    notification_type: URL_UPDATED | URL_DELETED
    """
    body = {"url": url, "type": notification_type}
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.post(PUBLISH_ENDPOINT, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise GoogleApiError(f"Blad polaczenia z Indexing API: {exc}") from exc

    data = _json(response)
    if response.status_code >= 400:
        raise parse_error(response.status_code, data)
    return data if isinstance(data, dict) else {}


def get_url_metadata(access_token: str, url: str) -> dict:
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.get(METADATA_ENDPOINT, params={"url": url}, headers=headers)
    except httpx.HTTPError as exc:
        raise GoogleApiError(f"Blad polaczenia z Indexing API: {exc}") from exc

    data = _json(response)
    if response.status_code >= 400:
        raise parse_error(response.status_code, data)
    return data if isinstance(data, dict) else {}


def _json(response: httpx.Response):
    try:
        return response.json()
    except ValueError:
        return response.text
