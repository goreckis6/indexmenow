from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from app.deps import CurrentUser, CurrentWorkspace, DbSession
from app.models import ActivityLog, IndexJob, JobStatus, JobType, Site
from app.services.sites import list_sites
from app.services.stats import job_totals
from app.templating import render

router = APIRouter(prefix="/history", tags=["history"])

PER_PAGE = 60


@router.get("")
def history_page(
    request: Request,
    user: CurrentUser,
    workspace: CurrentWorkspace,
    db: DbSession,
    site_id: int = 0,
    status: str = "",
    job_type: str = "",
    page: int = 1,
):
    query = (
        select(IndexJob)
        .join(Site, Site.id == IndexJob.site_id)
        .where(Site.workspace_id == workspace.id)
    )
    count_query = (
        select(func.count(IndexJob.id))
        .join(Site, Site.id == IndexJob.site_id)
        .where(Site.workspace_id == workspace.id)
    )

    if site_id:
        query = query.where(IndexJob.site_id == site_id)
        count_query = count_query.where(IndexJob.site_id == site_id)
    if status:
        query = query.where(IndexJob.status == status)
        count_query = count_query.where(IndexJob.status == status)
    if job_type:
        query = query.where(IndexJob.job_type == job_type)
        count_query = count_query.where(IndexJob.job_type == job_type)

    total = db.scalar(count_query) or 0
    page = max(page, 1)
    jobs = list(
        db.scalars(
            query.order_by(IndexJob.created_at.desc())
            .offset((page - 1) * PER_PAGE)
            .limit(PER_PAGE)
        )
    )

    sites = list_sites(db, workspace)
    site_map = {site.id: site for site in sites}

    activity = list(
        db.scalars(
            select(ActivityLog)
            .where(ActivityLog.workspace_id == workspace.id)
            .order_by(ActivityLog.created_at.desc())
            .limit(25)
        )
    )

    return render(
        request,
        "history.html",
        {
            "user": user,
            "workspace": workspace,
            "jobs": jobs,
            "activity": activity,
            "sites": sites,
            "site_map": site_map,
            "total": total,
            "page": page,
            "pages": max(1, (total + PER_PAGE - 1) // PER_PAGE),
            "filter_site": site_id,
            "filter_status": status,
            "filter_type": job_type,
            "statuses": [s.value for s in JobStatus],
            "job_types": [t.value for t in JobType],
            "totals": job_totals(db, workspace.id, 30),
            "active_page": "history",
        },
    )
