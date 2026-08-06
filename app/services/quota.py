from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Engine, IndexJob, JobStatus, QuotaUsage, Site, Workspace


def today() -> date:
    return datetime.now(timezone.utc).date()


def get_usage(db: Session, workspace_id: int, engine: str = Engine.GOOGLE, day: date | None = None) -> int:
    row = db.scalar(
        select(QuotaUsage.used).where(
            QuotaUsage.workspace_id == workspace_id,
            QuotaUsage.day == (day or today()),
            QuotaUsage.engine == engine,
        )
    )
    return row or 0


def remaining(db: Session, workspace: Workspace, engine: str = Engine.GOOGLE) -> int:
    return max(0, workspace.daily_quota - get_usage(db, workspace.id, engine))


def consume(db: Session, workspace_id: int, amount: int = 1, engine: str = Engine.GOOGLE) -> int:
    day = today()
    usage = db.scalar(
        select(QuotaUsage).where(
            QuotaUsage.workspace_id == workspace_id,
            QuotaUsage.day == day,
            QuotaUsage.engine == engine,
        )
    )
    if usage is None:
        usage = QuotaUsage(workspace_id=workspace_id, day=day, engine=engine, used=0)
        db.add(usage)
    usage.used += amount
    db.flush()
    return usage.used


def usage_history(db: Session, workspace_id: int, days: int = 14) -> list[dict]:
    start = today() - timedelta(days=days - 1)
    rows = db.execute(
        select(QuotaUsage.day, QuotaUsage.engine, QuotaUsage.used)
        .where(QuotaUsage.workspace_id == workspace_id, QuotaUsage.day >= start)
        .order_by(QuotaUsage.day)
    ).all()

    buckets: dict[date, dict[str, int]] = {
        start + timedelta(days=i): {} for i in range(days)
    }
    for day, engine, used in rows:
        buckets.setdefault(day, {})[engine] = used

    return [
        {"day": day.isoformat(), **{"google": data.get(Engine.GOOGLE, 0)}, "engines": data}
        for day, data in sorted(buckets.items())
    ]


def submissions_last_days(db: Session, workspace_id: int, days: int = 30) -> list[dict]:
    start = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days - 1)
    rows = db.execute(
        select(
            func.date(IndexJob.created_at).label("day"),
            IndexJob.status,
            func.count(IndexJob.id),
        )
        .join(Site, Site.id == IndexJob.site_id)
        .where(
            Site.workspace_id == workspace_id,
            IndexJob.created_at >= start,
            IndexJob.job_type.in_(["URL_UPDATED", "URL_DELETED", "INDEXNOW"]),
        )
        .group_by("day", IndexJob.status)
    ).all()

    series: dict[str, dict[str, int]] = {}
    for i in range(days):
        key = (start + timedelta(days=i)).date().isoformat()
        series[key] = {"success": 0, "failed": 0}
    for day, status, count in rows:
        bucket = series.setdefault(str(day), {"success": 0, "failed": 0})
        if status == JobStatus.SUCCESS:
            bucket["success"] += count
        elif status == JobStatus.FAILED:
            bucket["failed"] += count

    return [{"day": day, **values} for day, values in sorted(series.items())]
