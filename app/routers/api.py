from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from app.deps import ApiUser, CurrentWorkspace, DbSession, get_site_or_404
from app.models import IndexJob, IndexStatus, PageUrl, Site
from app.services import quota
from app.services.scheduler import next_run_times, running_tasks
from app.services.stats import workspace_indexing_history
from app.services.urls import site_url_stats, workspace_url_stats

router = APIRouter(prefix="/api", tags=["api"])


@router.get("/overview")
def overview(user: ApiUser, workspace: CurrentWorkspace, db: DbSession):
    used = quota.get_usage(db, workspace.id)
    return {
        "workspace": {"id": workspace.id, "name": workspace.name},
        "urls": workspace_url_stats(db, workspace.id),
        "quota": {
            "used": used,
            "limit": workspace.daily_quota,
            "remaining": max(0, workspace.daily_quota - used),
        },
        "sites": db.scalar(
            select(func.count(Site.id)).where(Site.workspace_id == workspace.id)
        ),
        "history": workspace_indexing_history(db, workspace.id, 30),
        "submissions": quota.submissions_last_days(db, workspace.id, 30),
    }


@router.get("/tasks")
def tasks_status(user: ApiUser, workspace: CurrentWorkspace, db: DbSession):
    running = running_tasks()
    recent = list(
        db.scalars(
            select(IndexJob)
            .join(Site, Site.id == IndexJob.site_id)
            .where(Site.workspace_id == workspace.id)
            .order_by(IndexJob.created_at.desc())
            .limit(8)
        )
    )
    return {
        "running": running,
        "busy": bool(running),
        "next_runs": next_run_times(),
        "recent": [
            {
                "id": job.id,
                "target": job.target,
                "type": job.job_type,
                "status": job.status,
                "message": job.message,
                "created_at": job.created_at.isoformat() if job.created_at else None,
            }
            for job in recent
        ],
    }


@router.get("/sites/{site_id}/summary")
def site_summary(site_id: int, user: ApiUser, workspace: CurrentWorkspace, db: DbSession):
    site = get_site_or_404(db, workspace, site_id)
    return {
        "id": site.id,
        "name": site.display_name,
        "property": site.property_url,
        "auto_index": site.auto_index,
        "stats": site_url_stats(db, site.id),
        "last_scan_at": site.last_scan_at.isoformat() if site.last_scan_at else None,
        "last_index_run_at": site.last_index_run_at.isoformat()
        if site.last_index_run_at
        else None,
        "busy": f"site:{site.id}" in running_tasks(),
    }


@router.get("/urls/{url_id}")
def url_detail(url_id: int, user: ApiUser, workspace: CurrentWorkspace, db: DbSession):
    page = db.scalar(
        select(PageUrl)
        .join(Site, Site.id == PageUrl.site_id)
        .where(PageUrl.id == url_id, Site.workspace_id == workspace.id)
    )
    if page is None:
        return {"detail": "Nie znaleziono"}

    jobs = list(
        db.scalars(
            select(IndexJob)
            .where(IndexJob.url_id == page.id)
            .order_by(IndexJob.created_at.desc())
            .limit(10)
        )
    )
    return {
        "id": page.id,
        "url": page.url,
        "status": page.index_status,
        "coverage_state": page.coverage_state,
        "verdict": page.verdict,
        "robots_state": page.robots_state,
        "page_fetch_state": page.page_fetch_state,
        "canonical_google": page.canonical_google,
        "canonical_user": page.canonical_user,
        "last_crawl_at": page.last_crawl_at.isoformat() if page.last_crawl_at else None,
        "last_checked_at": page.last_checked_at.isoformat() if page.last_checked_at else None,
        "last_submitted_at": page.last_submitted_at.isoformat()
        if page.last_submitted_at
        else None,
        "submit_count": page.submit_count,
        "error": page.error_message,
        "jobs": [
            {
                "type": job.job_type,
                "status": job.status,
                "message": job.message,
                "created_at": job.created_at.isoformat() if job.created_at else None,
            }
            for job in jobs
        ],
    }


@router.get("/status-breakdown")
def status_breakdown(user: ApiUser, workspace: CurrentWorkspace, db: DbSession):
    rows = db.execute(
        select(PageUrl.index_status, func.count(PageUrl.id))
        .join(Site, Site.id == PageUrl.site_id)
        .where(Site.workspace_id == workspace.id)
        .group_by(PageUrl.index_status)
    ).all()
    counts = {status.value: 0 for status in IndexStatus}
    for status, count in rows:
        counts[status] = count
    return counts
