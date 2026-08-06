from __future__ import annotations

from fastapi import APIRouter, Form, Request
from fastapi.responses import PlainTextResponse, RedirectResponse
from sqlalchemy import select

from app.deps import CurrentUser, CurrentWorkspace, DbSession, flash, get_site_or_404
from app.google.errors import GoogleApiError
from app.google.indexnow import key_file_url
from app.models import IndexJob, PageUrl, Sitemap
from app.security import generate_indexnow_key
from app.services import quota, sitemaps as sitemap_service, sites as site_service, tasks
from app.services.scheduler import is_running, run_in_background
from app.services.stats import workspace_indexing_history
from app.services.urls import site_url_stats
from app.templating import render

router = APIRouter(prefix="/sites", tags=["sites"])


def _back(site_id: int, tab: str = "") -> RedirectResponse:
    suffix = f"?tab={tab}" if tab else ""
    return RedirectResponse(f"/sites/{site_id}{suffix}", status_code=303)


@router.get("")
def sites_page(request: Request, user: CurrentUser, workspace: CurrentWorkspace, db: DbSession):
    sites = site_service.list_sites(db, workspace)
    rows = []
    for site in sites:
        stats = site_url_stats(db, site.id)
        rows.append(
            {
                "site": site,
                "stats": stats,
                "sitemaps": db.scalar(
                    select(Sitemap).where(Sitemap.site_id == site.id).limit(1)
                )
                is not None,
                "busy": is_running(f"site:{site.id}"),
            }
        )
    return render(
        request,
        "sites.html",
        {
            "user": user,
            "workspace": workspace,
            "rows": rows,
            "active_page": "sites",
        },
    )


@router.post("/import")
def import_sites(request: Request, user: CurrentUser, workspace: CurrentWorkspace, db: DbSession):
    try:
        result = site_service.import_sites_from_gsc(db, user, workspace)
    except GoogleApiError as exc:
        flash(request, f"Nie udalo sie pobrac stron z Search Console: {exc}", "error")
        return RedirectResponse("/sites", status_code=303)

    flash(
        request,
        f"Import zakonczony: {result['created']} nowych, {result['updated']} zaktualizowanych"
        + (f", {result['skipped']} pominietych (brak weryfikacji)." if result["skipped"] else "."),
        "success",
    )
    return RedirectResponse("/sites", status_code=303)


@router.post("/add")
def add_site(
    request: Request,
    workspace: CurrentWorkspace,
    db: DbSession,
    property_url: str = Form(...),
):
    if not property_url.strip():
        flash(request, "Podaj adres strony.", "error")
        return RedirectResponse("/sites", status_code=303)

    site = site_service.create_site(db, workspace, property_url)
    flash(request, f"Dodano strone {site.display_name}.", "success")
    return _back(site.id)


@router.get("/{site_id}")
def site_detail(
    request: Request,
    site_id: int,
    user: CurrentUser,
    workspace: CurrentWorkspace,
    db: DbSession,
    tab: str = "overview",
    status: str = "",
    q: str = "",
    page: int = 1,
):
    site = get_site_or_404(db, workspace, site_id)
    per_page = 50

    query = select(PageUrl).where(PageUrl.site_id == site.id)
    if status:
        query = query.where(PageUrl.index_status == status)
    if q:
        query = query.where(PageUrl.url.contains(q))

    total = len(db.scalars(query).all())
    urls = list(
        db.scalars(
            query.order_by(PageUrl.index_status, PageUrl.id.desc())
            .offset((max(page, 1) - 1) * per_page)
            .limit(per_page)
        )
    )

    return render(
        request,
        "site_detail.html",
        {
            "user": user,
            "workspace": workspace,
            "site": site,
            "stats": site_url_stats(db, site.id),
            "sitemaps": list(
                db.scalars(select(Sitemap).where(Sitemap.site_id == site.id).order_by(Sitemap.id))
            ),
            "urls": urls,
            "total_urls": total,
            "page": max(page, 1),
            "per_page": per_page,
            "pages": max(1, (total + per_page - 1) // per_page),
            "filter_status": status,
            "query": q,
            "tab": tab,
            "jobs": list(
                db.scalars(
                    select(IndexJob)
                    .where(IndexJob.site_id == site.id)
                    .order_by(IndexJob.created_at.desc())
                    .limit(30)
                )
            ),
            "history": workspace_indexing_history(db, workspace.id, 30),
            "quota_left": quota.remaining(db, workspace),
            "busy": is_running(f"site:{site.id}"),
            "indexnow_url": key_file_url(site.home_url, site.indexnow_key or ""),
            "active_page": "sites",
        },
    )


@router.post("/{site_id}/settings")
def update_site_settings(
    request: Request,
    site_id: int,
    workspace: CurrentWorkspace,
    db: DbSession,
    display_name: str = Form(""),
    daily_limit: int = Form(50),
    priority: int = Form(0),
    auto_index: bool = Form(False),
    indexnow_enabled: bool = Form(False),
    is_active: bool = Form(False),
):
    site = get_site_or_404(db, workspace, site_id)
    if display_name.strip():
        site.display_name = display_name.strip()[:255]
    site.daily_limit = max(0, min(daily_limit, 10000))
    site.priority = max(0, min(priority, 100))
    site.auto_index = auto_index
    site.indexnow_enabled = indexnow_enabled
    site.is_active = is_active
    if indexnow_enabled and not site.indexnow_key:
        site.indexnow_key = generate_indexnow_key()
    db.commit()
    flash(request, "Ustawienia strony zapisane.", "success")
    return _back(site_id, "settings")


@router.post("/{site_id}/delete")
def delete_site(request: Request, site_id: int, workspace: CurrentWorkspace, db: DbSession):
    site = get_site_or_404(db, workspace, site_id)
    name = site.display_name
    db.delete(site)
    db.commit()
    flash(request, f"Usunieto strone {name} wraz z jej danymi.", "success")
    return RedirectResponse("/sites", status_code=303)


@router.post("/{site_id}/regenerate-key")
def regenerate_indexnow_key(
    request: Request, site_id: int, workspace: CurrentWorkspace, db: DbSession
):
    site = get_site_or_404(db, workspace, site_id)
    site.indexnow_key = generate_indexnow_key()
    db.commit()
    flash(request, "Wygenerowano nowy klucz IndexNow. Wgraj nowy plik na serwer.", "warning")
    return _back(site_id, "settings")


@router.get("/{site_id}/indexnow-key")
def download_indexnow_key(site_id: int, workspace: CurrentWorkspace, db: DbSession):
    site = get_site_or_404(db, workspace, site_id)
    key = site.indexnow_key or ""
    return PlainTextResponse(
        key,
        headers={"Content-Disposition": f'attachment; filename="{key}.txt"'},
    )


# ------------------------------------------------------------------ akcje


@router.post("/{site_id}/scan")
def scan_site(request: Request, site_id: int, workspace: CurrentWorkspace, db: DbSession):
    site = get_site_or_404(db, workspace, site_id)
    started = run_in_background(f"site:{site.id}", tasks.task_scan_sitemaps, site.id)
    flash(
        request,
        "Skanowanie sitemap uruchomione w tle." if started else "Zadanie dla tej strony juz trwa.",
        "success" if started else "warning",
    )
    return _back(site_id, "sitemaps")


@router.post("/{site_id}/inspect")
def inspect_site(
    request: Request,
    site_id: int,
    workspace: CurrentWorkspace,
    db: DbSession,
    limit: int = Form(50),
):
    site = get_site_or_404(db, workspace, site_id)
    started = run_in_background(f"site:{site.id}", tasks.task_inspect, site.id, limit)
    flash(
        request,
        f"Inspekcja {limit} URL-i uruchomiona w tle."
        if started
        else "Zadanie dla tej strony juz trwa.",
        "success" if started else "warning",
    )
    return _back(site_id, "urls")


@router.post("/{site_id}/run")
def run_pipeline(
    request: Request,
    site_id: int,
    workspace: CurrentWorkspace,
    db: DbSession,
    scan: bool = Form(True),
):
    site = get_site_or_404(db, workspace, site_id)
    if quota.remaining(db, workspace) <= 0:
        flash(request, "Dzienny limit zgloszen zostal wyczerpany.", "warning")
        return _back(site_id)

    started = run_in_background(f"site:{site.id}", tasks.task_run_pipeline, site.id, scan)
    flash(
        request,
        "Indeksowanie uruchomione: skan sitemap, inspekcja i zgloszenia."
        if started
        else "Zadanie dla tej strony juz trwa.",
        "success" if started else "warning",
    )
    return _back(site_id)


@router.post("/run-all")
def run_all(request: Request, workspace: CurrentWorkspace, db: DbSession):
    started = run_in_background(
        f"workspace:{workspace.id}", tasks.task_run_all_sites, workspace.id
    )
    flash(
        request,
        "Uruchomiono indeksowanie wszystkich stron."
        if started
        else "Indeksowanie juz trwa.",
        "success" if started else "warning",
    )
    return RedirectResponse("/sites", status_code=303)


# --------------------------------------------------------------- sitemapy


@router.post("/{site_id}/sitemaps/add")
def add_sitemap(
    request: Request,
    site_id: int,
    workspace: CurrentWorkspace,
    db: DbSession,
    path: str = Form(...),
    submit_to_google: bool = Form(False),
):
    site = get_site_or_404(db, workspace, site_id)
    sitemap = sitemap_service.add_sitemap(db, site, path)
    flash(request, f"Dodano sitemape {sitemap.path}.", "success")
    if submit_to_google:
        return RedirectResponse(
            f"/sites/{site_id}/sitemaps/{sitemap.id}/submit", status_code=307
        )
    return _back(site_id, "sitemaps")


@router.post("/{site_id}/sitemaps/sync")
def sync_sitemaps(
    request: Request, site_id: int, user: CurrentUser, workspace: CurrentWorkspace, db: DbSession
):
    site = get_site_or_404(db, workspace, site_id)
    try:
        result = sitemap_service.sync_from_gsc(db, user, site)
        flash(
            request,
            f"Zsynchronizowano sitemapy z GSC: {result['created']} nowych, "
            f"{result['updated']} zaktualizowanych.",
            "success",
        )
    except GoogleApiError as exc:
        flash(request, f"Blad synchronizacji sitemap: {exc}", "error")
    return _back(site_id, "sitemaps")


@router.post("/{site_id}/sitemaps/discover")
def discover_sitemaps(request: Request, site_id: int, workspace: CurrentWorkspace, db: DbSession):
    site = get_site_or_404(db, workspace, site_id)
    found = sitemap_service.discover_sitemaps(db, site)
    flash(
        request,
        f"Znaleziono {len(found)} sitemap." if found else "Nie znaleziono zadnej sitemapy.",
        "success" if found else "warning",
    )
    return _back(site_id, "sitemaps")


@router.post("/{site_id}/sitemaps/{sitemap_id}/submit")
def submit_sitemap(
    request: Request,
    site_id: int,
    sitemap_id: int,
    user: CurrentUser,
    workspace: CurrentWorkspace,
    db: DbSession,
):
    site = get_site_or_404(db, workspace, site_id)
    sitemap = db.get(Sitemap, sitemap_id)
    if sitemap is None or sitemap.site_id != site.id:
        flash(request, "Nie znaleziono sitemapy.", "error")
        return _back(site_id, "sitemaps")

    job = sitemap_service.submit_to_google(db, user, site, sitemap)
    flash(request, job.message or "Zgloszono sitemape.", "success" if job.status == "SUCCESS" else "error")
    return _back(site_id, "sitemaps")


@router.post("/{site_id}/sitemaps/{sitemap_id}/scan")
def scan_single_sitemap(
    request: Request, site_id: int, sitemap_id: int, workspace: CurrentWorkspace, db: DbSession
):
    site = get_site_or_404(db, workspace, site_id)
    sitemap = db.get(Sitemap, sitemap_id)
    if sitemap is None or sitemap.site_id != site.id:
        flash(request, "Nie znaleziono sitemapy.", "error")
        return _back(site_id, "sitemaps")

    result = sitemap_service.scan_sitemap(db, site, sitemap)
    if result.get("error"):
        flash(request, f"Blad skanowania: {result['error']}", "error")
    else:
        flash(
            request,
            f"Zaimportowano {result['added']} nowych URL-i "
            f"({result['duplicates']} juz istnialo).",
            "success",
        )
    return _back(site_id, "sitemaps")


@router.post("/{site_id}/sitemaps/{sitemap_id}/delete")
def delete_sitemap(
    request: Request,
    site_id: int,
    sitemap_id: int,
    user: CurrentUser,
    workspace: CurrentWorkspace,
    db: DbSession,
    from_google: bool = Form(False),
):
    site = get_site_or_404(db, workspace, site_id)
    sitemap = db.get(Sitemap, sitemap_id)
    if sitemap is None or sitemap.site_id != site.id:
        flash(request, "Nie znaleziono sitemapy.", "error")
        return _back(site_id, "sitemaps")

    if from_google:
        job = sitemap_service.delete_from_google(db, user, site, sitemap)
        if job.status != "SUCCESS":
            flash(request, f"Google: {job.message}", "warning")

    db.delete(sitemap)
    db.commit()
    flash(request, "Sitemapa usunieta.", "success")
    return _back(site_id, "sitemaps")
