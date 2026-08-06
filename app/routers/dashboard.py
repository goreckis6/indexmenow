from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from app.deps import CurrentUser, CurrentWorkspace, DbSession
from app.models import Engine, PageUrl, Site
from app.services import quota
from app.services.scheduler import next_run_times, running_tasks
from app.services.stats import job_totals, recent_jobs, workspace_indexing_history
from app.services.urls import workspace_url_stats
from app.services.workspaces import list_workspaces
from app.templating import render

router = APIRouter(tags=["dashboard"])


@router.get("/")
def dashboard(request: Request, user: CurrentUser, workspace: CurrentWorkspace, db: DbSession):
    sites = list(
        db.scalars(
            select(Site)
            .where(Site.workspace_id == workspace.id)
            .order_by(Site.priority.desc(), Site.display_name)
        )
    )

    per_site_counts = dict(
        db.execute(
            select(PageUrl.site_id, func.count(PageUrl.id))
            .join(Site, Site.id == PageUrl.site_id)
            .where(Site.workspace_id == workspace.id, PageUrl.is_active.is_(True))
            .group_by(PageUrl.site_id)
        ).all()
    )
    per_site_indexed = dict(
        db.execute(
            select(PageUrl.site_id, func.count(PageUrl.id))
            .join(Site, Site.id == PageUrl.site_id)
            .where(
                Site.workspace_id == workspace.id,
                PageUrl.is_active.is_(True),
                PageUrl.index_status == "INDEXED",
            )
            .group_by(PageUrl.site_id)
        ).all()
    )

    site_rows = []
    for site in sites:
        total = per_site_counts.get(site.id, 0)
        indexed = per_site_indexed.get(site.id, 0)
        site_rows.append(
            {
                "site": site,
                "total": total,
                "indexed": indexed,
                "coverage": round(indexed / total * 100) if total else 0,
            }
        )

    stats = workspace_url_stats(db, workspace.id)
    used_today = quota.get_usage(db, workspace.id, Engine.GOOGLE)

    return render(
        request,
        "dashboard.html",
        {
            "user": user,
            "workspace": workspace,
            "workspaces": list_workspaces(db, user),
            "stats": stats,
            "site_rows": site_rows,
            "quota_used": used_today,
            "quota_limit": workspace.daily_quota,
            "quota_percent": round(used_today / workspace.daily_quota * 100)
            if workspace.daily_quota
            else 0,
            "history": workspace_indexing_history(db, workspace.id, 30),
            "submissions": quota.submissions_last_days(db, workspace.id, 30),
            "jobs": recent_jobs(db, workspace.id, 12),
            "job_totals": job_totals(db, workspace.id, 30),
            "next_runs": next_run_times(),
            "running": running_tasks(),
            "active_page": "dashboard",
        },
    )
