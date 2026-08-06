from __future__ import annotations

import base64
import hashlib
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "IndexMePlease"
    host: str = "0.0.0.0"
    port: int = 8006
    base_url: str = "http://localhost:8006"
    secret_key: str = "insecure-dev-key-change-me"
    debug: bool = False
    log_level: str = "INFO"
    timezone: str = "Europe/Warsaw"

    google_client_id: str = ""
    google_client_secret: str = ""
    allowed_emails: str = ""

    database_url: str = "sqlite:///./data/indexmeplease.db"

    default_daily_quota: int = 200
    sitemap_scan_interval_hours: int = 12
    auto_index_hour: int = 3
    inspection_batch_size: int = 50
    api_throttle_seconds: float = 0.6
    recheck_after_days: int = 7

    @field_validator("base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @property
    def redirect_uri(self) -> str:
        return f"{self.base_url}/auth/callback"

    @property
    def is_https(self) -> bool:
        """Behind a TLS-terminating proxy the session cookie must be secure-only."""
        return self.base_url.startswith("https://")

    @property
    def allowed_email_list(self) -> list[str]:
        return [e.strip().lower() for e in self.allowed_emails.split(",") if e.strip()]

    @property
    def google_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def fernet_key(self) -> bytes:
        """Deterministic Fernet key derived from the app secret."""
        digest = hashlib.sha256(self.secret_key.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(digest)

    @property
    def data_dir(self) -> Path:
        if self.database_url.startswith("sqlite"):
            raw = self.database_url.split("sqlite:///", 1)[-1]
            path = Path(raw)
            if not path.is_absolute():
                path = BASE_DIR / raw
            return path.parent
        return BASE_DIR / "data"

    @property
    def sqlalchemy_url(self) -> str:
        if self.database_url.startswith("sqlite:///./"):
            relative = self.database_url.replace("sqlite:///./", "", 1)
            return f"sqlite:///{(BASE_DIR / relative).as_posix()}"
        return self.database_url


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return settings


settings = get_settings()
