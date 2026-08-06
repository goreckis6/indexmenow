from __future__ import annotations

from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.google import search_console as gsc
from app.google.errors import GoogleApiError
from app.google.oauth import get_access_token
from app.models import IndexJob, JobStatus, JobType, Site, Sitemap, User
from app.services import sitemap_parser
from app.services.activity import log_event
from app.services.urls import add_urls


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def sync_from_gsc(db: Session, user: User, site: Site) -> dict:
    """Mirror the sitemap list Google already knows about."""
    token = get_access_token(db, user)
    entries = gsc.list_sitemaps(token, site.property_url)

    created = 0
    updated = 0
    for entry in entries:
        path = entry.get("path")
        if not path:
            continue
        sitemap = db.scalar(
            select(Sitemap).where(Sitemap.site_id == site.id, Sitemap.path == path)
        )
        if sitemap is None:
            sitemap = Sitemap(site_id=site.id, path=path, source="gsc")
            db.add(sitemap)
            created += 1
        else:
            updated += 1

        sitemap.is_pending = bool(entry.get("isPending"))
        sitemap.is_sitemaps_index = bool(entry.get("isSitemapsIndex"))
        sitemap.warnings = int(entry.get("warnings", 0) or 0)
        sitemap.errors = int(entry.get("errors", 0) or 0)
        contents = entry.get("contents") or []
        sitemap.url_count = sum(int(c.get("submitted", 0) or 0) for c in contents)
        sitemap.last_submitted_at = _parse_ts(entry.get("lastSubmitted"))
        sitemap.last_downloaded_at = _parse_ts(entry.get("lastDownloaded"))

    db.commit()
    return {"created": created, "updated": updated, "total": len(entries)}


def discover_sitemaps(db: Session, site: Site) -> list[str]:
    """Probe well-known sitemap paths and robots.txt."""
    found: list[str] = []
    for candidate in sitemap_parser.guess_sitemap_urls(site.home_url):
        try:
            with httpx.Client(timeout=12, follow_redirects=True) as client:
                response = client.head(
                    candidate, headers={"User-Agent": sitemap_parser.USER_AGENT}
                )
                if response.status_code >= 400:
                    response = client.get(
                        candidate, headers={"User-Agent": sitemap_parser.USER_AGENT}
                    )
            if response.status_code < 400:
                found.append(candidate)
        except httpx.HTTPError:
            continue

    for path in found:
        existing = db.scalar(
            select(Sitemap).where(Sitemap.site_id == site.id, Sitemap.path == path)
        )
        if existing is None:
            db.add(Sitemap(site_id=site.id, path=path, source="discovered"))
    db.commit()
    return found


def add_sitemap(db: Session, site: Site, path: str) -> Sitemap:
    clean = path.strip()
    if not clean.startswith("http"):
        clean = site.home_url.rstrip("/") + "/" + clean.lstrip("/")
    existing = db.scalar(select(Sitemap).where(Sitemap.site_id == site.id, Sitemap.path == clean))
    if existing:
        return existing
    sitemap = Sitemap(site_id=site.id, path=clean, source="manual")
    db.add(sitemap)
    db.commit()
    db.refresh(sitemap)
    return sitemap


def submit_to_google(db: Session, user: User, site: Site, sitemap: Sitemap) -> IndexJob:
    job = IndexJob(
        site_id=site.id,
        target=sitemap.path,
        job_type=JobType.SITEMAP_SUBMIT,
        status=JobStatus.RUNNING,
    )
    db.add(job)
    db.flush()

    try:
        token = get_access_token(db, user)
        gsc.submit_sitemap(token, site.property_url, sitemap.path)
        sitemap.last_submitted_at = _now()
        job.status = JobStatus.SUCCESS
        job.message = "Sitemapa zgloszona do Google Search Console"
    except GoogleApiError as exc:
        job.status = JobStatus.FAILED
        job.message = str(exc)
    finally:
        job.finished_at = _now()
        db.commit()
    return job


def delete_from_google(db: Session, user: User, site: Site, sitemap: Sitemap) -> IndexJob:
    job = IndexJob(
        site_id=site.id,
        target=sitemap.path,
        job_type=JobType.SITEMAP_DELETE,
        status=JobStatus.RUNNING,
    )
    db.add(job)
    db.flush()

    try:
        token = get_access_token(db, user)
        gsc.delete_sitemap(token, site.property_url, sitemap.path)
        job.status = JobStatus.SUCCESS
        job.message = "Sitemapa usunieta z Google Search Console"
    except GoogleApiError as exc:
        job.status = JobStatus.FAILED
        job.message = str(exc)
    finally:
        job.finished_at = _now()
        db.commit()
    return job


def scan_sitemap(db: Session, site: Site, sitemap: Sitemap) -> dict:
    """Download the sitemap and import every URL it contains."""
    result = sitemap_parser.crawl_sitemap(sitemap.path)
    if result.error and not result.entries:
        sitemap.errors = (sitemap.errors or 0) + 1
        db.commit()
        return {"added": 0, "duplicates": 0, "error": result.error, "found": 0}

    valid = [
        entry
        for entry in result.entries
        if sitemap_parser.url_belongs_to_site(entry.url, site.home_url, site.is_domain_property)
    ]
    lastmod_map = {entry.url: entry.lastmod for entry in valid if entry.lastmod}
    outcome = add_urls(
        db, site, [entry.url for entry in valid], source="sitemap", lastmod_map=lastmod_map
    )

    sitemap.url_count = len(valid)
    sitemap.last_downloaded_at = _now()
    sitemap.is_sitemaps_index = result.is_index
    site.last_scan_at = _now()
    db.commit()

    outcome["found"] = len(result.entries)
    outcome["error"] = result.error
    return outcome


def scan_all_sitemaps(db: Session, site: Site) -> dict:
    totals = {"added": 0, "duplicates": 0, "found": 0, "sitemaps": 0, "errors": []}
    sitemaps = list(
        db.scalars(
            select(Sitemap).where(Sitemap.site_id == site.id, Sitemap.auto_sync.is_(True))
        )
    )
    if not sitemaps:
        discover_sitemaps(db, site)
        sitemaps = list(db.scalars(select(Sitemap).where(Sitemap.site_id == site.id)))

    for sitemap in sitemaps:
        outcome = scan_sitemap(db, site, sitemap)
        totals["added"] += outcome["added"]
        totals["duplicates"] += outcome["duplicates"]
        totals["found"] += outcome.get("found", 0)
        totals["sitemaps"] += 1
        if outcome.get("error"):
            totals["errors"].append(f"{sitemap.path}: {outcome['error']}")

    log_event(
        db,
        f"Skan sitemap dla {site.display_name}: +{totals['added']} nowych URL-i.",
        workspace_id=site.workspace_id,
        category="sitemap",
        details=totals,
        commit=True,
    )
    return totals


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None
