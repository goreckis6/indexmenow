"""Punkt wejscia aplikacji.

Uruchomienie:
    py run.py
albo:
    py -m uvicorn app.main:app --host 0.0.0.0 --port 8006
"""

from __future__ import annotations

import socket

import uvicorn

from app.config import settings


def local_ip() -> str:
    """Best-effort detection of the LAN address the panel will answer on."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def main() -> None:
    ip = local_ip()
    print()
    print("  IndexMePlease")
    print("  " + "-" * 52)
    print(f"  Lokalnie:     http://127.0.0.1:{settings.port}")
    print(f"  W sieci LAN:  http://{ip}:{settings.port}")
    print(f"  BASE_URL:     {settings.base_url}")
    print(f"  Redirect URI: {settings.redirect_uri}")
    if not settings.google_configured:
        print("  UWAGA: brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET w .env")
    print("  " + "-" * 52)
    print()

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    main()
