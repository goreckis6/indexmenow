from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, urlunparse

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import IndexStatus, PageUrl, Site

TRACKING_PARAMS = {
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
    "msclkid",
}


def normalize_url(raw: str) -> str | None:
    value = (raw or "").strip()
    if not value or value.startswith("#"):
        return None
    if not value.startswith(("http://", "https://")):
        value = "https://" + value.lstrip("/")

    parsed = urlparse(value)
    if not parsed.netloc:
        return None

    query_parts = [
        part
        for part in parsed.query.split("&")
        if part and part.split("=", 1)[0].lower() not in TRACKING_PARAMS
    ]
    cleaned = parsed._replace(query="&".join(query_parts), fragment="")
    return urlunparse(cleaned)


def parse_url_blob(blob: str) -> list[str]:
    """Accept newline, comma or space separated URLs."""
    tokens: list[str] = []
    for line in (blob or "").replace(",", "\n").splitlines():
        for token in line.split():
            normalized = normalize_url(token)
            if normalized:
                tokens.append(normalized)
    seen: set[str] = set()
    unique = []
    for token in tokens:
        if token not in seen:
            seen.add(token)
            unique.append(token)
    return unique


def add_urls(
    db: Session,
    site: Site,
    urls: list[str],
    source: str = "manual",
    lastmod_map: dict[str, datetime] | None = None,
    priority: int = 0,
) -> dict:
    existing = {
        row[0]
        for row in db.execute(select(PageUrl.url).where(PageUrl.site_id == site.id)).all()
    }
    added = 0
    duplicates = 0
    refreshed = 0

    for url in urls:
        if url in existing:
            duplicates += 1
            if lastmod_map and url in lastmod_map:
                page = db.scalar(
                    select(PageUrl).where(PageUrl.site_id == site.id, PageUrl.url == url)
                )
                if page and page.lastmod != lastmod_map[url]:
                    page.lastmod = lastmod_map[url]
                    refreshed += 1
            continue

        db.add(
            PageUrl(
                site_id=site.id,
                url=url[:2048],
                source=source,
                priority=priority,
                lastmod=(lastmod_map or {}).get(url),
            )
        )
        existing.add(url)
        added += 1

    db.commit()
    return {"added": added, "duplicates": duplicates, "refreshed": refreshed, "total": len(urls)}


def site_url_stats(db: Session, site_id: int) -> dict:
    rows = db.execute(
        select(PageUrl.index_status, func.count(PageUrl.id))
        .where(PageUrl.site_id == site_id, PageUrl.is_active.is_(True))
        .group_by(PageUrl.index_status)
    ).all()
    counts = {status.value: 0 for status in IndexStatus}
    for status, count in rows:
        counts[status] = count
    counts["total"] = sum(counts[s.value] for s in IndexStatus)
    known = counts["total"] - counts[IndexStatus.UNKNOWN]
    counts["coverage"] = round(counts[IndexStatus.INDEXED] / known * 100, 1) if known else 0.0
    return counts


def workspace_url_stats(db: Session, workspace_id: int) -> dict:
    rows = db.execute(
        select(PageUrl.index_status, func.count(PageUrl.id))
        .join(Site, Site.id == PageUrl.site_id)
        .where(Site.workspace_id == workspace_id, PageUrl.is_active.is_(True))
        .group_by(PageUrl.index_status)
    ).all()
    counts = {status.value: 0 for status in IndexStatus}
    for status, count in rows:
        counts[status] = count
    counts["total"] = sum(counts[s.value] for s in IndexStatus)
    known = counts["total"] - counts[IndexStatus.UNKNOWN]
    counts["coverage"] = round(counts[IndexStatus.INDEXED] / known * 100, 1) if known else 0.0
    return counts


def pick_urls_for_inspection(db: Session, site: Site, limit: int, recheck_days: int) -> list[PageUrl]:
    """Never-checked URLs first, then the stalest ones."""
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=recheck_days)
    never_checked = list(
        db.scalars(
            select(PageUrl)
            .where(
                PageUrl.site_id == site.id,
                PageUrl.is_active.is_(True),
                PageUrl.last_checked_at.is_(None),
            )
            .order_by(PageUrl.priority.desc(), PageUrl.id)
            .limit(limit)
        )
    )
    if len(never_checked) >= limit:
        return never_checked

    stale = list(
        db.scalars(
            select(PageUrl)
            .where(
                PageUrl.site_id == site.id,
                PageUrl.is_active.is_(True),
                PageUrl.last_checked_at.is_not(None),
                PageUrl.last_checked_at < cutoff,
                PageUrl.index_status != IndexStatus.INDEXED,
            )
            .order_by(PageUrl.last_checked_at)
            .limit(limit - len(never_checked))
        )
    )
    return never_checked + stale


def pick_urls_for_submission(db: Session, site: Site, limit: int) -> list[PageUrl]:
    """Prefer confirmed not-indexed URLs, then unknown ones."""
    not_indexed = list(
        db.scalars(
            select(PageUrl)
            .where(
                PageUrl.site_id == site.id,
                PageUrl.is_active.is_(True),
                PageUrl.index_status.in_([IndexStatus.NOT_INDEXED, IndexStatus.ERROR]),
            )
            .order_by(PageUrl.priority.desc(), PageUrl.last_submitted_at.is_not(None),
                      PageUrl.last_submitted_at, PageUrl.id)
            .limit(limit)
        )
    )
    if len(not_indexed) >= limit:
        return not_indexed

    unknown = list(
        db.scalars(
            select(PageUrl)
            .where(
                PageUrl.site_id == site.id,
                PageUrl.is_active.is_(True),
                PageUrl.index_status == IndexStatus.UNKNOWN,
                PageUrl.last_submitted_at.is_(None),
            )
            .order_by(PageUrl.priority.desc(), PageUrl.id)
            .limit(limit - len(not_indexed))
        )
    )
    return not_indexed + unknown
