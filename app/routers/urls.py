from __future__ import annotations

import csv
import io
from typing import Annotated

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import RedirectResponse, StreamingResponse
from sqlalchemy import func, select

from app.deps import CurrentUser, CurrentWorkspace, DbSession, flash, get_site_or_404
from app.models import IndexStatus, PageUrl, Site
from app.services import tasks
from app.services import urls as url_service
from app.services.scheduler import run_in_background
from app.services.sites import list_sites
from app.templating import render

router = APIRouter(prefix="/urls", tags=["urls"])

PER_PAGE = 100


@router.get("")
def urls_page(
    request: Request,
    user: CurrentUser,
    workspace: CurrentWorkspace,
    db: DbSession,
    site_id: int = 0,
    status: str = "",
    q: str = "",
    page: int = 1,
):
    query = (
        select(PageUrl)
        .join(Site, Site.id == PageUrl.site_id)
        .where(Site.workspace_id == workspace.id)
    )
    count_query = (
        select(func.count(PageUrl.id))
        .join(Site, Site.id == PageUrl.site_id)
        .where(Site.workspace_id == workspace.id)
    )

    if site_id:
        query = query.where(PageUrl.site_id == site_id)
        count_query = count_query.where(PageUrl.site_id == site_id)
    if status:
        query = query.where(PageUrl.index_status == status)
        count_query = count_query.where(PageUrl.index_status == status)
    if q:
        query = query.where(PageUrl.url.contains(q))
        count_query = count_query.where(PageUrl.url.contains(q))

    total = db.scalar(count_query) or 0
    page = max(page, 1)
    rows = list(
        db.scalars(
            query.order_by(PageUrl.last_checked_at.is_(None).desc(), PageUrl.id.desc())
            .offset((page - 1) * PER_PAGE)
            .limit(PER_PAGE)
        )
    )
    site_map = {site.id: site for site in list_sites(db, workspace)}

    return render(
        request,
        "urls.html",
        {
            "user": user,
            "workspace": workspace,
            "rows": rows,
            "sites": list(site_map.values()),
            "site_map": site_map,
            "total": total,
            "page": page,
            "pages": max(1, (total + PER_PAGE - 1) // PER_PAGE),
            "filter_site": site_id,
            "filter_status": status,
            "query": q,
            "statuses": [s.value for s in IndexStatus],
            "stats": url_service.workspace_url_stats(db, workspace.id),
            "active_page": "urls",
        },
    )


@router.post("/add")
def add_urls(
    request: Request,
    workspace: CurrentWorkspace,
    db: DbSession,
    site_id: int = Form(...),
    urls_blob: str = Form(""),
    priority: int = Form(0),
    submit_now: bool = Form(False),
    file: Annotated[UploadFile | None, File()] = None,
):
    site = get_site_or_404(db, workspace, site_id)

    blob = urls_blob or ""
    if file is not None and file.filename:
        try:
            blob += "\n" + file.file.read().decode("utf-8", errors="ignore")
        except Exception:  # noqa: BLE001
            flash(request, "Nie udalo sie odczytac pliku.", "error")

    candidates = url_service.parse_url_blob(blob)
    if not candidates:
        flash(request, "Nie znaleziono zadnego poprawnego adresu URL.", "error")
        return RedirectResponse(f"/sites/{site_id}?tab=urls", status_code=303)

    from app.services.sitemap_parser import url_belongs_to_site

    valid = [u for u in candidates if url_belongs_to_site(u, site.home_url, site.is_domain_property)]
    rejected = len(candidates) - len(valid)

    result = url_service.add_urls(db, site, valid, source="manual", priority=priority)
    message = f"Dodano {result['added']} URL-i ({result['duplicates']} juz istnialo)."
    if rejected:
        message += f" Odrzucono {rejected} adresow spoza domeny {site.display_name}."
    flash(request, message, "success" if result["added"] else "warning")

    if submit_now and result["added"]:
        new_ids = [
            row[0]
            for row in db.execute(
                select(PageUrl.id).where(
                    PageUrl.site_id == site.id,
                    PageUrl.url.in_(valid),
                )
            ).all()
        ]
        run_in_background(f"site:{site.id}", tasks.task_submit_urls, site.id, new_ids)
        flash(request, "Zgloszenie do Google uruchomione w tle.", "success")

    return RedirectResponse(f"/sites/{site_id}?tab=urls", status_code=303)


@router.post("/action")
def bulk_action(
    request: Request,
    workspace: CurrentWorkspace,
    db: DbSession,
    action: str = Form(...),
    url_ids: Annotated[list[int], Form()] = [],  # noqa: B006
    redirect_to: str = Form("/urls"),
):
    if not url_ids:
        flash(request, "Nie zaznaczono zadnego URL-a.", "warning")
        return RedirectResponse(redirect_to, status_code=303)

    pages = list(
        db.scalars(
            select(PageUrl)
            .join(Site, Site.id == PageUrl.site_id)
            .where(PageUrl.id.in_(url_ids), Site.workspace_id == workspace.id)
        )
    )
    if not pages:
        flash(request, "Nie znaleziono wskazanych URL-i.", "error")
        return RedirectResponse(redirect_to, status_code=303)

    by_site: dict[int, list[int]] = {}
    for page in pages:
        by_site.setdefault(page.site_id, []).append(page.id)

    if action == "submit":
        for site_id, ids in by_site.items():
            run_in_background(f"site:{site_id}", tasks.task_submit_urls, site_id, ids)
        flash(request, f"Zgloszono {len(pages)} URL-i do indeksowania (w tle).", "success")
    elif action == "inspect":
        for site_id, ids in by_site.items():
            run_in_background(f"site:{site_id}", tasks.task_inspect_urls, site_id, ids)
        flash(request, f"Uruchomiono inspekcje {len(pages)} URL-i (w tle).", "success")
    elif action == "delete":
        for page in pages:
            db.delete(page)
        db.commit()
        flash(request, f"Usunieto {len(pages)} URL-i.", "success")
    elif action == "priority":
        for page in pages:
            page.priority = 10
        db.commit()
        flash(request, f"Ustawiono wysoki priorytet dla {len(pages)} URL-i.", "success")
    elif action == "reset":
        for page in pages:
            page.index_status = IndexStatus.UNKNOWN
            page.last_checked_at = None
        db.commit()
        flash(request, f"Zresetowano status {len(pages)} URL-i.", "success")
    else:
        flash(request, f"Nieznana akcja: {action}", "error")

    return RedirectResponse(redirect_to, status_code=303)


@router.get("/export.csv")
def export_csv(workspace: CurrentWorkspace, db: DbSession, site_id: int = 0, status: str = ""):
    query = (
        select(PageUrl, Site.display_name)
        .join(Site, Site.id == PageUrl.site_id)
        .where(Site.workspace_id == workspace.id)
    )
    if site_id:
        query = query.where(PageUrl.site_id == site_id)
    if status:
        query = query.where(PageUrl.index_status == status)

    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";")
    writer.writerow(
        [
            "strona",
            "url",
            "status",
            "coverage_state",
            "verdict",
            "ostatnia_inspekcja",
            "ostatnie_zgloszenie",
            "liczba_zgloszen",
            "zrodlo",
        ]
    )
    for page, site_name in db.execute(query).all():
        writer.writerow(
            [
                site_name,
                page.url,
                page.index_status,
                page.coverage_state or "",
                page.verdict or "",
                page.last_checked_at.isoformat() if page.last_checked_at else "",
                page.last_submitted_at.isoformat() if page.last_submitted_at else "",
                page.submit_count,
                page.source,
            ]
        )

    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="indexmeplease-urls.csv"'},
    )
