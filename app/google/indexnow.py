from __future__ import annotations

from urllib.parse import urlparse

import httpx

from app.google.errors import GoogleApiError

# IndexNow is shared by Bing, Yandex, Seznam and Naver.
ENDPOINTS = {
    "bing": "https://www.bing.com/indexnow",
    "yandex": "https://yandex.com/indexnow",
    "seznam": "https://search.seznam.cz/indexnow",
    "generic": "https://api.indexnow.org/indexnow",
}

TIMEOUT = httpx.Timeout(30.0, connect=10.0)

STATUS_MEANING = {
    200: "Przyjeto zgloszenie",
    202: "Przyjeto - klucz oczekuje na weryfikacje",
    400: "Nieprawidlowy format zadania",
    403: "Klucz nieprawidlowy lub niedostepny pod podanym adresem",
    422: "URL-e nie naleza do tej domeny albo klucz sie nie zgadza",
    429: "Zbyt wiele zgloszen (rate limit)",
}


def submit_urls(
    urls: list[str], key: str, key_location: str | None = None, engine: str = "generic"
) -> dict:
    if not urls:
        return {"status": 0, "message": "Brak URL-i do zgloszenia", "count": 0}

    host = urlparse(urls[0]).netloc
    if not host:
        raise GoogleApiError(f"Nieprawidlowy URL: {urls[0]}")

    payload = {"host": host, "key": key, "urlList": urls[:10000]}
    if key_location:
        payload["keyLocation"] = key_location

    endpoint = ENDPOINTS.get(engine, ENDPOINTS["generic"])
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.post(
                endpoint, json=payload, headers={"Content-Type": "application/json; charset=utf-8"}
            )
    except httpx.HTTPError as exc:
        raise GoogleApiError(f"Blad polaczenia z IndexNow: {exc}") from exc

    message = STATUS_MEANING.get(response.status_code, f"HTTP {response.status_code}")
    ok = response.status_code in (200, 202)
    return {
        "ok": ok,
        "status": response.status_code,
        "message": message,
        "count": len(urls),
        "endpoint": endpoint,
        "body": (response.text or "")[:500],
    }


def key_file_url(site_home_url: str, key: str) -> str:
    parsed = urlparse(site_home_url)
    scheme = parsed.scheme or "https"
    return f"{scheme}://{parsed.netloc}/{key}.txt"
