from __future__ import annotations


class GoogleApiError(Exception):
    """Normalised error coming back from any Google endpoint."""

    def __init__(self, message: str, status_code: int | None = None, payload: dict | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}

    @property
    def is_quota(self) -> bool:
        return self.status_code == 429 or "quota" in self.message.lower()

    @property
    def is_permission(self) -> bool:
        return self.status_code in (401, 403)

    def __str__(self) -> str:  # pragma: no cover - trivial
        if self.status_code:
            return f"[{self.status_code}] {self.message}"
        return self.message


def parse_error(status_code: int, body: dict | str) -> GoogleApiError:
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            message = err.get("message") or str(err)
            return GoogleApiError(message, status_code, body)
        if isinstance(err, str):
            desc = body.get("error_description")
            return GoogleApiError(f"{err}: {desc}" if desc else err, status_code, body)
        return GoogleApiError(str(body)[:500], status_code, body)
    return GoogleApiError(str(body)[:500], status_code)
