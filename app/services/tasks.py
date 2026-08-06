from __future__ import annotations

import logging

from sqlalchemy import select

from app.database import session_scope
from app.models import PageUrl, Site, User, Workspace
from app.services import indexer, sitemaps
from app.services.activity import log_event

logger = logging.getLogger("indexmeplease.tasks")


def _load(db, site_id: int):
    site = db.get(Site, site_id)
    if site is None:
        raise ValueError(f"Site {site_id} nie istnieje")
    workspace = db.get(Workspace, site.workspace_id)
    user = db.get(User, workspace.user_id)
    return site, workspace, user


def task_scan_sitemaps(site_id: int) -> None:
    with session_scope() as db:
        site, _, _ = _load(db, site_id)
        sitemaps.scan_all_sitemaps(db, site)


def task_inspect(site_id: int, limit: int | None = None) -> None:
    with session_scope() as db:
        site, _, user = _load(db, site_id)
        summary = indexer.inspect_batch(db, user, site, limit, triggered_by="manual")
        log_event(
            db,
            f"Inspekcja {site.display_name}: sprawdzono {summary['checked']} URL-i "
            f"({summary['indexed']} zaindeksowanych).",
            workspace_id=site.workspace_id,
            category="inspection",
            details=summary,
        )


def task_run_pipeline(site_id: int, scan: bool = True) -> None:
    with session_scope() as db:
        site, workspace, user = _load(db, site_id)
        indexer.run_site_pipeline(
            db, user, workspace, site, triggered_by="manual", scan_sitemaps=scan
        )


def task_submit_urls(site_id: int, url_ids: list[int]) -> None:
    with session_scope() as db:
        site, workspace, user = _load(db, site_id)
        pages = list(
            db.scalars(
                select(PageUrl).where(PageUrl.id.in_(url_ids), PageUrl.site_id == site.id)
            )
        )
        summary = indexer.submit_batch(db, user, workspace, site, pages)
        log_event(
            db,
            f"Zgloszono {summary['submitted']} URL-i dla {site.display_name}.",
            workspace_id=site.workspace_id,
            category="indexing",
            details=summary,
        )


def task_inspect_urls(site_id: int, url_ids: list[int]) -> None:
    with session_scope() as db:
        site, _, user = _load(db, site_id)
        pages = list(
            db.scalars(
                select(PageUrl).where(PageUrl.id.in_(url_ids), PageUrl.site_id == site.id)
            )
        )
        for page in pages:
            indexer.inspect_single(db, user, site, page)


def task_run_all_sites(workspace_id: int) -> None:
    with session_scope() as db:
        workspace = db.get(Workspace, workspace_id)
        user = db.get(User, workspace.user_id)
        sites = list(
            db.scalars(
                select(Site).where(
                    Site.workspace_id == workspace_id, Site.is_active.is_(True)
                )
            )
        )
        for site in sites:
            try:
                indexer.run_site_pipeline(db, user, workspace, site, triggered_by="manual")
            except Exception:  # noqa: BLE001
                logger.exception("Pipeline failed for site %s", site.id)
