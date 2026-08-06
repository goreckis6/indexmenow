from __future__ import annotations

from datetime import date, datetime, timezone
from enum import StrEnum

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class IndexStatus(StrEnum):
    UNKNOWN = "UNKNOWN"
    INDEXED = "INDEXED"
    NOT_INDEXED = "NOT_INDEXED"
    EXCLUDED = "EXCLUDED"
    ERROR = "ERROR"


class JobType(StrEnum):
    URL_UPDATED = "URL_UPDATED"
    URL_DELETED = "URL_DELETED"
    INSPECT = "INSPECT"
    SITEMAP_SUBMIT = "SITEMAP_SUBMIT"
    SITEMAP_DELETE = "SITEMAP_DELETE"
    INDEXNOW = "INDEXNOW"


class JobStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


class Engine(StrEnum):
    GOOGLE = "google"
    BING = "bing"
    YANDEX = "yandex"
    SEZNAM = "seznam"
    NAVER = "naver"


# ---------------------------------------------------------------- users


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    google_sub: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(255))
    picture: Mapped[str | None] = mapped_column(String(512))
    locale: Mapped[str | None] = mapped_column(String(16))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)

    workspaces: Mapped[list["Workspace"]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )
    credential: Mapped["GoogleCredential | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )


class GoogleCredential(Base):
    """OAuth tokens for the signed-in Google account."""

    __tablename__ = "google_credentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    access_token_enc: Mapped[str] = mapped_column(Text)
    refresh_token_enc: Mapped[str | None] = mapped_column(Text)
    token_type: Mapped[str] = mapped_column(String(32), default="Bearer")
    scopes: Mapped[str] = mapped_column(Text, default="")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    user: Mapped[User] = relationship(back_populates="credential")

    @property
    def scope_list(self) -> list[str]:
        return [s for s in self.scopes.split(" ") if s]


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    slug: Mapped[str] = mapped_column(String(140), index=True)
    daily_quota: Mapped[int] = mapped_column(Integer, default=200)
    auto_index_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    email_reports: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    owner: Mapped[User] = relationship(back_populates="workspaces")
    sites: Mapped[list["Site"]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan"
    )
    service_accounts: Mapped[list["ServiceAccount"]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan"
    )


class ServiceAccount(Base):
    """Optional Google service account used for the Indexing API."""

    __tablename__ = "service_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(160))
    client_email: Mapped[str] = mapped_column(String(320))
    project_id: Mapped[str | None] = mapped_column(String(160))
    private_key_id: Mapped[str | None] = mapped_column(String(80))
    private_key_enc: Mapped[str] = mapped_column(Text)
    daily_quota: Mapped[int] = mapped_column(Integer, default=200)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    workspace: Mapped[Workspace] = relationship(back_populates="service_accounts")


# ---------------------------------------------------------------- sites


class Site(Base):
    __tablename__ = "sites"
    __table_args__ = (UniqueConstraint("workspace_id", "property_url", name="uq_site_property"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    # Search Console property, e.g. "https://example.com/" or "sc-domain:example.com"
    property_url: Mapped[str] = mapped_column(String(512))
    display_name: Mapped[str] = mapped_column(String(255))
    home_url: Mapped[str] = mapped_column(String(512))
    permission_level: Mapped[str | None] = mapped_column(String(64))
    auto_index: Mapped[bool] = mapped_column(Boolean, default=False)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    daily_limit: Mapped[int] = mapped_column(Integer, default=50)
    indexnow_key: Mapped[str | None] = mapped_column(String(64))
    indexnow_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_scan_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_index_run_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    workspace: Mapped[Workspace] = relationship(back_populates="sites")
    urls: Mapped[list["PageUrl"]] = relationship(
        back_populates="site", cascade="all, delete-orphan"
    )
    sitemaps: Mapped[list["Sitemap"]] = relationship(
        back_populates="site", cascade="all, delete-orphan"
    )
    jobs: Mapped[list["IndexJob"]] = relationship(
        back_populates="site", cascade="all, delete-orphan"
    )
    stats: Mapped[list["SiteStat"]] = relationship(
        back_populates="site", cascade="all, delete-orphan"
    )

    @property
    def is_domain_property(self) -> bool:
        return self.property_url.startswith("sc-domain:")


class Sitemap(Base):
    __tablename__ = "sitemaps"
    __table_args__ = (UniqueConstraint("site_id", "path", name="uq_sitemap_path"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(1024))
    source: Mapped[str] = mapped_column(String(16), default="manual")  # manual | gsc | discovered
    is_pending: Mapped[bool] = mapped_column(Boolean, default=False)
    is_sitemaps_index: Mapped[bool] = mapped_column(Boolean, default=False)
    url_count: Mapped[int] = mapped_column(Integer, default=0)
    warnings: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[int] = mapped_column(Integer, default=0)
    last_submitted_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_downloaded_at: Mapped[datetime | None] = mapped_column(DateTime)
    auto_sync: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    site: Mapped[Site] = relationship(back_populates="sitemaps")


class PageUrl(Base):
    __tablename__ = "urls"
    __table_args__ = (UniqueConstraint("site_id", "url", name="uq_site_url"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), index=True)
    url: Mapped[str] = mapped_column(String(2048), index=True)
    source: Mapped[str] = mapped_column(String(16), default="manual")  # manual | sitemap | import
    index_status: Mapped[str] = mapped_column(
        String(24), default=IndexStatus.UNKNOWN, index=True
    )
    coverage_state: Mapped[str | None] = mapped_column(String(255))
    robots_state: Mapped[str | None] = mapped_column(String(64))
    page_fetch_state: Mapped[str | None] = mapped_column(String(64))
    canonical_google: Mapped[str | None] = mapped_column(String(2048))
    canonical_user: Mapped[str | None] = mapped_column(String(2048))
    verdict: Mapped[str | None] = mapped_column(String(32))
    last_crawl_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    last_submitted_at: Mapped[datetime | None] = mapped_column(DateTime)
    submit_count: Mapped[int] = mapped_column(Integer, default=0)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    lastmod: Mapped[datetime | None] = mapped_column(DateTime)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    site: Mapped[Site] = relationship(back_populates="urls")
    jobs: Mapped[list["IndexJob"]] = relationship(back_populates="page_url")


class IndexJob(Base):
    __tablename__ = "index_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), index=True)
    url_id: Mapped[int | None] = mapped_column(
        ForeignKey("urls.id", ondelete="SET NULL"), index=True
    )
    target: Mapped[str] = mapped_column(String(2048))
    job_type: Mapped[str] = mapped_column(String(24), default=JobType.URL_UPDATED)
    engine: Mapped[str] = mapped_column(String(16), default=Engine.GOOGLE)
    status: Mapped[str] = mapped_column(String(16), default=JobStatus.PENDING, index=True)
    triggered_by: Mapped[str] = mapped_column(String(16), default="manual")  # manual | auto
    message: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSON)
    duration_ms: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)

    site: Mapped[Site] = relationship(back_populates="jobs")
    page_url: Mapped[PageUrl | None] = relationship(back_populates="jobs")


class QuotaUsage(Base):
    __tablename__ = "quota_usage"
    __table_args__ = (
        UniqueConstraint("workspace_id", "day", "engine", name="uq_quota_day_engine"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    day: Mapped[date] = mapped_column(Date, index=True)
    engine: Mapped[str] = mapped_column(String(16), default=Engine.GOOGLE)
    used: Mapped[int] = mapped_column(Integer, default=0)


class SiteStat(Base):
    __tablename__ = "site_stats"
    __table_args__ = (UniqueConstraint("site_id", "day", name="uq_sitestat_day"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), index=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    total_urls: Mapped[int] = mapped_column(Integer, default=0)
    indexed: Mapped[int] = mapped_column(Integer, default=0)
    not_indexed: Mapped[int] = mapped_column(Integer, default=0)
    submitted: Mapped[int] = mapped_column(Integer, default=0)
    inspected: Mapped[int] = mapped_column(Integer, default=0)

    site: Mapped[Site] = relationship(back_populates="stats")


class ActivityLog(Base):
    __tablename__ = "activity_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    workspace_id: Mapped[int | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    level: Mapped[str] = mapped_column(String(16), default="info")
    category: Mapped[str] = mapped_column(String(32), default="system")
    message: Mapped[str] = mapped_column(Text)
    details: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
