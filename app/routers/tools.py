from __future__ import annotations

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse

from app.deps import CurrentUser, CurrentWorkspace, DbSession, flash, get_site_or_404
from app.models import JobType, PageUrl
from app.services import indexer
from app.services.seo_tools import fetch_page_meta
from app.services.sitemap_parser import crawl_sitemap
from app.services.sites import list_sites
from app.services.urls import normalize_url, parse_url_blob
from app.templating import render

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("")
def tools_page(request: Request, user: CurrentUser, workspace: CurrentWorkspace, db: DbSession):
    return render(
        request,
        "tools.html",
        {
            "user": user,
            "workspace": workspace,
            "sites": list_sites(db, workspace),
            "active_page": "tools",
            "tool": request.query_params.get("tool", "instant"),
        },
    )


@router.post("/instant")
def instant_index(
    request: Request,
    user: CurrentUser,
    workspace: CurrentWorkspace,
    db: DbSession,
    site_id: int = Form(...),
    urls_blob: str = Form(...),
    notification_type: str = Form("URL_UPDATED"),
):
    site = get_site_or_404(db, workspace, site_id)
    candidates = parse_url_blob(urls_blob)
    if not candidates:
        flash(request, "Nie podano poprawnych adresow URL.", "error")
        return RedirectResponse("/tools?tool=instant", status_code=303)

    job_type = JobType.URL_DELETED if notification_type == "URL_DELETED" else JobType.URL_UPDATED
    results = {"success": 0, "failed": 0, "messages": []}

    from sqlalchemy import select

    for url in candidates[:50]:
        page = db.scalar(select(PageUrl).where(PageUrl.site_id == site.id, PageUrl.url == url))
        if page is None:
            page = PageUrl(site_id=site.id, url=url, source="manual")
            db.add(page)
            db.flush()

        job = indexer.submit_single(
            db, user, workspace, site, page, url, job_type=job_type, triggered_by="manual"
        )
        if job.status == "SUCCESS":
            results["success"] += 1
        else:
            results["failed"] += 1
            if job.message:
                results["messages"].append(f"{url}: {job.message}")

    if results["success"]:
        flash(request, f"Zgloszono {results['success']} URL-i do Google.", "success")
    for message in results["messages"][:3]:
        flash(request, message, "error")

    return RedirectResponse("/tools?tool=instant", status_code=303)


@router.post("/indexnow")
def indexnow_submit(
    request: Request,
    workspace: CurrentWorkspace,
    db: DbSession,
    site_id: int = Form(...),
    urls_blob: str = Form(...),
):
    site = get_site_or_404(db, workspace, site_id)
    candidates = parse_url_blob(urls_blob)
    if not candidates:
        flash(request, "Nie podano poprawnych adresow URL.", "error")
        return RedirectResponse("/tools?tool=indexnow", status_code=303)

    result = indexer.submit_indexnow(db, site, candidates)
    flash(
        request,
        f"IndexNow: {result.get('message')}",
        "success" if result.get("ok") else "error",
    )
    return RedirectResponse("/tools?tool=indexnow", status_code=303)


@router.get("/preview")
def preview_tool(
    request: Request, user: CurrentUser, workspace: CurrentWorkspace, db: DbSession, url: str = ""
):
    meta = None
    if url:
        normalized = normalize_url(url)
        meta = fetch_page_meta(normalized) if normalized else {"error": "Nieprawidlowy URL."}

    return render(
        request,
        "tools.html",
        {
            "user": user,
            "workspace": workspace,
            "sites": list_sites(db, workspace),
            "meta": meta,
            "preview_url": url,
            "tool": "preview",
            "active_page": "tools",
        },
    )


@router.get("/sitemap")
def sitemap_tool(
    request: Request, user: CurrentUser, workspace: CurrentWorkspace, db: DbSession, url: str = ""
):
    result = None
    if url:
        normalized = normalize_url(url)
        if normalized:
            crawled = crawl_sitemap(normalized)
            result = {
                "source": crawled.source,
                "is_index": crawled.is_index,
                "error": crawled.error,
                "child_sitemaps": crawled.child_sitemaps,
                "count": len(crawled.entries),
                "entries": crawled.entries[:500],
            }
        else:
            result = {"error": "Nieprawidlowy URL."}

    return render(
        request,
        "tools.html",
        {
            "user": user,
            "workspace": workspace,
            "sites": list_sites(db, workspace),
            "sitemap_result": result,
            "sitemap_url": url,
            "tool": "sitemap",
            "active_page": "tools",
        },
    )
