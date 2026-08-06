from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import IndexJob, IndexStatus, JobStatus, PageUrl, Site, SiteStat


def record_site_snapshot(db: Session, site: Site, submitted: int = 0, inspected: int = 0) -> SiteStat:
    day = datetime.now(timezone.utc).date()
    rows = db.execute(
        select(PageUrl.index_status, func.count(PageUrl.id))
        .where(PageUrl.site_id == site.id, PageUrl.is_active.is_(True))
        .group_by(PageUrl.index_status)
    ).all()
    counts = {status: count for status, count in rows}

    stat = db.scalar(select(SiteStat).where(SiteStat.site_id == site.id, SiteStat.day == day))
    if stat is None:
        stat = SiteStat(site_id=site.id, day=day)
        db.add(stat)

    stat.total_urls = sum(counts.values())
    stat.indexed = counts.get(IndexStatus.INDEXED, 0)
    stat.not_indexed = counts.get(IndexStatus.NOT_INDEXED, 0) + counts.get(IndexStatus.EXCLUDED, 0)
    stat.submitted = (stat.submitted or 0) + submitted
    stat.inspected = (stat.inspected or 0) + inspected
    db.flush()
    return stat


def workspace_indexing_history(db: Session, workspace_id: int, days: int = 30) -> list[dict]:
    start: date = datetime.now(timezone.utc).date() - timedelta(days=days - 1)
    rows = db.execute(
        select(
            SiteStat.day,
            func.sum(SiteStat.indexed),
            func.sum(SiteStat.not_indexed),
            func.sum(SiteStat.total_urls),
        )
        .join(Site, Site.id == SiteStat.site_id)
        .where(Site.workspace_id == workspace_id, SiteStat.day >= start)
        .group_by(SiteStat.day)
        .order_by(SiteStat.day)
    ).all()

    known = {
        day.isoformat() if hasattr(day, "isoformat") else str(day): {
            "indexed": int(indexed or 0),
            "not_indexed": int(not_indexed or 0),
            "total": int(total or 0),
        }
        for day, indexed, not_indexed, total in rows
    }

    series = []
    last = {"indexed": 0, "not_indexed": 0, "total": 0}
    for i in range(days):
        key = (start + timedelta(days=i)).isoformat()
        point = known.get(key, last)
        last = point
        series.append({"day": key, **point})
    return series


def recent_jobs(db: Session, workspace_id: int, limit: int = 15) -> list[IndexJob]:
    return list(
        db.scalars(
            select(IndexJob)
            .join(Site, Site.id == IndexJob.site_id)
            .where(Site.workspace_id == workspace_id)
            .order_by(IndexJob.created_at.desc())
            .limit(limit)
        )
    )


def job_totals(db: Session, workspace_id: int, days: int = 30) -> dict:
    start = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    rows = db.execute(
        select(IndexJob.status, func.count(IndexJob.id))
        .join(Site, Site.id == IndexJob.site_id)
        .where(Site.workspace_id == workspace_id, IndexJob.created_at >= start)
        .group_by(IndexJob.status)
    ).all()
    totals = {status.value: 0 for status in JobStatus}
    for status, count in rows:
        totals[status] = count
    totals["all"] = sum(totals[s.value] for s in JobStatus)
    return totals
