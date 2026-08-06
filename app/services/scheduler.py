from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import select

from app.config import settings
from app.database import session_scope
from app.models import Site, User, Workspace
from app.services.activity import log_event
from app.services.stats import record_site_snapshot

logger = logging.getLogger("indexmeplease.scheduler")

scheduler = BackgroundScheduler(timezone=settings.timezone)

_running_tasks: set[str] = set()
_lock = threading.Lock()


class TaskBusy(Exception):
    pass


def _claim(task_key: str) -> bool:
    with _lock:
        if task_key in _running_tasks:
            return False
        _running_tasks.add(task_key)
        return True


def _release(task_key: str) -> None:
    with _lock:
        _running_tasks.discard(task_key)


def is_running(task_key: str) -> bool:
    with _lock:
        return task_key in _running_tasks


def running_tasks() -> list[str]:
    with _lock:
        return sorted(_running_tasks)


def run_in_background(task_key: str, func, *args, **kwargs) -> bool:
    """Queue a one-off job; returns False when the same task is already running."""
    if is_running(task_key):
        return False

    def _wrapped():
        if not _claim(task_key):
            return
        try:
            func(*args, **kwargs)
        except Exception:  # noqa: BLE001
            logger.exception("Zadanie w tle nie powiodlo sie: %s", task_key)
        finally:
            _release(task_key)

    scheduler.add_job(
        _wrapped,
        trigger=DateTrigger(run_date=datetime.now(timezone.utc) + timedelta(seconds=1)),
        id=f"{task_key}:{datetime.now(timezone.utc).timestamp()}",
        misfire_grace_time=300,
    )
    return True


# ---------------------------------------------------------------- jobs


def job_auto_index() -> None:
    """Daily pass over every site that has auto-indexing enabled."""
    from app.services.indexer import run_site_pipeline

    task_key = "auto-index-all"
    if not _claim(task_key):
        logger.info("Auto-indeksowanie juz trwa - pomijam.")
        return

    try:
        with session_scope() as db:
            workspaces = list(
                db.scalars(select(Workspace).where(Workspace.auto_index_enabled.is_(True)))
            )
            for workspace in workspaces:
                user = db.get(User, workspace.user_id)
                if user is None or not user.is_active or user.credential is None:
                    continue
                sites = list(
                    db.scalars(
                        select(Site).where(
                            Site.workspace_id == workspace.id,
                            Site.auto_index.is_(True),
                            Site.is_active.is_(True),
                        )
                    )
                )
                for site in sites:
                    try:
                        run_site_pipeline(db, user, workspace, site, triggered_by="auto")
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("Auto-index failed for %s", site.display_name)
                        log_event(
                            db,
                            f"Auto-indeksowanie {site.display_name} nie powiodlo sie: {exc}",
                            workspace_id=workspace.id,
                            level="error",
                            category="indexing",
                        )
    finally:
        _release(task_key)


def job_scan_sitemaps() -> None:
    from app.services.sitemaps import scan_all_sitemaps

    task_key = "scan-sitemaps-all"
    if not _claim(task_key):
        return
    try:
        with session_scope() as db:
            sites = list(db.scalars(select(Site).where(Site.is_active.is_(True))))
            for site in sites:
                try:
                    scan_all_sitemaps(db, site)
                except Exception:  # noqa: BLE001
                    logger.exception("Sitemap scan failed for %s", site.display_name)
    finally:
        _release(task_key)


def job_daily_snapshot() -> None:
    with session_scope() as db:
        for site in db.scalars(select(Site)):
            record_site_snapshot(db, site)


def start_scheduler() -> None:
    if scheduler.running:
        return

    scheduler.add_job(
        job_auto_index,
        trigger=CronTrigger(hour=settings.auto_index_hour, minute=0),
        id="auto-index",
        replace_existing=True,
        max_instances=1,
        misfire_grace_time=3600,
    )
    scheduler.add_job(
        job_scan_sitemaps,
        trigger=IntervalTrigger(hours=settings.sitemap_scan_interval_hours),
        id="scan-sitemaps",
        replace_existing=True,
        max_instances=1,
        misfire_grace_time=3600,
    )
    scheduler.add_job(
        job_daily_snapshot,
        trigger=CronTrigger(hour=23, minute=50),
        id="daily-snapshot",
        replace_existing=True,
        max_instances=1,
        misfire_grace_time=3600,
    )
    scheduler.start()
    logger.info(
        "Scheduler wystartowal (auto-index o %02d:00, skan sitemap co %sh)",
        settings.auto_index_hour,
        settings.sitemap_scan_interval_hours,
    )


def shutdown_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)


def next_run_times() -> list[dict]:
    if not scheduler.running:
        return []
    return [
        {
            "id": job.id,
            "next_run": job.next_run_time.isoformat() if job.next_run_time else None,
        }
        for job in scheduler.get_jobs()
        if not job.id.startswith(("auto-index:", "scan-"))
        or job.id in ("auto-index", "scan-sitemaps", "daily-snapshot")
    ]
