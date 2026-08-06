from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from app.google.errors import GoogleApiError, parse_error

WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3"
SEARCHCONSOLE_BASE = "https://searchconsole.googleapis.com/v1"

TIMEOUT = httpx.Timeout(45.0, connect=15.0)


def _request(
    method: str,
    url: str,
    access_token: str,
    *,
    json_body: dict | None = None,
    params: dict | None = None,
) -> Any:
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.request(
                method, url, headers=headers, json=json_body, params=params
            )
    except httpx.HTTPError as exc:
        raise GoogleApiError(f"Blad polaczenia z Google: {exc}") from exc

    if response.status_code == 204 or not response.content:
        return {}
    try:
        data = response.json()
    except ValueError:
        data = response.text
    if response.status_code >= 400:
        raise parse_error(response.status_code, data)
    return data


def encode_property(property_url: str) -> str:
    return quote(property_url, safe="")


# ------------------------------------------------------------------ sites


def list_sites(access_token: str) -> list[dict]:
    data = _request("GET", f"{WEBMASTERS_BASE}/sites", access_token)
    return data.get("siteEntry", []) if isinstance(data, dict) else []


def get_site(access_token: str, property_url: str) -> dict:
    return _request(
        "GET", f"{WEBMASTERS_BASE}/sites/{encode_property(property_url)}", access_token
    )


# --------------------------------------------------------------- sitemaps


def list_sitemaps(access_token: str, property_url: str) -> list[dict]:
    data = _request(
        "GET",
        f"{WEBMASTERS_BASE}/sites/{encode_property(property_url)}/sitemaps",
        access_token,
    )
    return data.get("sitemap", []) if isinstance(data, dict) else []


def submit_sitemap(access_token: str, property_url: str, feedpath: str) -> dict:
    return _request(
        "PUT",
        f"{WEBMASTERS_BASE}/sites/{encode_property(property_url)}"
        f"/sitemaps/{encode_property(feedpath)}",
        access_token,
    )


def delete_sitemap(access_token: str, property_url: str, feedpath: str) -> dict:
    return _request(
        "DELETE",
        f"{WEBMASTERS_BASE}/sites/{encode_property(property_url)}"
        f"/sitemaps/{encode_property(feedpath)}",
        access_token,
    )


# --------------------------------------------------------- url inspection


def inspect_url(
    access_token: str, property_url: str, inspection_url: str, language_code: str = "pl"
) -> dict:
    body = {
        "inspectionUrl": inspection_url,
        "siteUrl": property_url,
        "languageCode": language_code,
    }
    return _request(
        "POST", f"{SEARCHCONSOLE_BASE}/urlInspection/index:inspect", access_token, json_body=body
    )


# ------------------------------------------------------- search analytics


def search_analytics(
    access_token: str,
    property_url: str,
    start_date: str,
    end_date: str,
    dimensions: list[str] | None = None,
    row_limit: int = 1000,
) -> list[dict]:
    body = {
        "startDate": start_date,
        "endDate": end_date,
        "dimensions": dimensions or ["date"],
        "rowLimit": row_limit,
    }
    data = _request(
        "POST",
        f"{WEBMASTERS_BASE}/sites/{encode_property(property_url)}/searchAnalytics/query",
        access_token,
        json_body=body,
    )
    return data.get("rows", []) if isinstance(data, dict) else []
