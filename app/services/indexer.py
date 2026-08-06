from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.google import indexing, indexnow
from app.google import search_console as gsc
from app.google.errors import GoogleApiError
from app.google.oauth import get_access_token
from app.google.service_account import credentials_info, get_service_account_token
from app.models import (
    Engine,
    IndexJob,
    IndexStatus,
    JobStatus,
    JobType,
    PageUrl,
    ServiceAccount,
    Site,
    User,
    Workspace,
)
from app.security import decrypt
from app.services import quota
from app.services.activity import log_event
from app.services.stats import record_site_snapshot
from app.services.urls import pick_urls_for_inspection, pick_urls_for_submission

logger = logging.getLogger("indexmeplease.indexer")

EXCLUSION_MARKERS = (
    "excluded",
    "duplicate",
    "alternate page",
    "noindex",
    "redirect",
    "not found",
    "soft 404",
    "blocked",
    "canonical",
)
NOT_INDEXED_MARKERS = ("not indexed", "unknown to google", "discovered", "crawled -")


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ------------------------------------------------------------ credentials


def resolve_indexing_token(db: Session, user: User, workspace: Workspace) -> tuple[str, str]:
    """Prefer a service account (own quota pool), fall back to the user's OAuth token."""
    account = db.scalar(
        select(ServiceAccount)
        .where(
            ServiceAccount.workspace_id == workspace.id,
            ServiceAccount.is_active.is_(True),
        )
        .order_by(ServiceAccount.last_used_at.is_not(None), ServiceAccount.last_used_at)
    )
    if account is not None:
        private_key = decrypt(account.private_key_enc)
        if private_key:
            info = credentials_info(account.client_email, private_key, account.project_id)
            token = get_service_account_token(info)
            account.last_used_at = _now()
            db.flush()
            return token, f"service-account:{account.client_email}"

    return get_access_token(db, user), f"oauth:{user.email}"


# ------------------------------------------------------------- inspection


def map_index_status(verdict: str | None, coverage_state: str | None) -> IndexStatus:
    coverage = (coverage_state or "").lower()
    if verdict == "PASS":
        return IndexStatus.INDEXED
    if any(marker in coverage for marker in NOT_INDEXED_MARKERS):
        return IndexStatus.NOT_INDEXED
    if any(marker in coverage for marker in EXCLUSION_MARKERS):
        return IndexStatus.EXCLUDED
    if verdict in ("FAIL", "NEUTRAL", "PARTIAL"):
        return IndexStatus.NOT_INDEXED
    return IndexStatus.UNKNOWN


def apply_inspection(page: PageUrl, payload: dict) -> IndexStatus:
    result = (payload or {}).get("inspectionResult", {})
    status_result = result.get("indexStatusResult", {})

    verdict = status_result.get("verdict")
    coverage = status_result.get("coverageState")
    status = map_index_status(verdict, coverage)

    page.index_status = status
    page.verdict = verdict
    page.coverage_state = (coverage or "")[:255] or None
    page.robots_state = status_result.get("robotsTxtState")
    page.page_fetch_state = status_result.get("pageFetchState")
    page.canonical_google = (status_result.get("googleCanonical") or "")[:2048] or None
    page.canonical_user = (status_result.get("userCanonical") or "")[:2048] or None
    page.last_checked_at = _now()
    page.error_message = None

    crawl_time = status_result.get("lastCrawlTime")
    if crawl_time:
        try:
            page.last_crawl_at = datetime.fromisoformat(
                crawl_time.replace("Z", "+00:00")
            ).replace(tzinfo=None)
        except ValueError:
            pass
    return status


def inspect_single(db: Session, user: User, site: Site, page: PageUrl) -> IndexJob:
    job = IndexJob(
        site_id=site.id,
        url_id=page.id,
        target=page.url,
        job_type=JobType.INSPECT,
        engine=Engine.GOOGLE,
        status=JobStatus.RUNNING,
    )
    db.add(job)
    db.flush()

    started = time.perf_counter()
    try:
        token = get_access_token(db, user)
        payload = gsc.inspect_url(token, site.property_url, page.url)
        status = apply_inspection(page, payload)
        job.status = JobStatus.SUCCESS
        job.message = page.coverage_state or status.value
        job.payload = (payload or {}).get("inspectionResult", {}).get("indexStatusResult")
    except GoogleApiError as exc:
        page.last_checked_at = _now()
        page.error_message = str(exc)[:500]
        if page.index_status == IndexStatus.UNKNOWN:
            page.index_status = IndexStatus.ERROR
        job.status = JobStatus.FAILED
        job.message = str(exc)
    finally:
        job.duration_ms = round((time.perf_counter() - started) * 1000, 1)
        job.finished_at = _now()
        db.commit()
    return job


def inspect_batch(
    db: Session, user: User, site: Site, limit: int | None = None, triggered_by: str = "manual"
) -> dict:
    limit = limit or settings.inspection_batch_size
    pages = pick_urls_for_inspection(db, site, limit, settings.recheck_after_days)

    summary = {"checked": 0, "indexed": 0, "not_indexed": 0, "excluded": 0, "errors": 0}
    for page in pages:
        job = inspect_single(db, user, site, page)
        job.triggered_by = triggered_by
        summary["checked"] += 1
        if job.status == JobStatus.FAILED:
            summary["errors"] += 1
            if "quota" in (job.message or "").lower():
                break
        elif page.index_status == IndexStatus.INDEXED:
            summary["indexed"] += 1
        elif page.index_status == IndexStatus.EXCLUDED:
            summary["excluded"] += 1
        else:
            summary["not_indexed"] += 1
        time.sleep(settings.api_throttle_seconds)

    record_site_snapshot(db, site, inspected=summary["checked"])
    db.commit()
    return summary


# ------------------------------------------------------------ submissions


def submit_single(
    db: Session,
    user: User,
    workspace: Workspace,
    site: Site,
    page: PageUrl | None,
    target: str,
    job_type: JobType = JobType.URL_UPDATED,
    triggered_by: str = "manual",
    token: str | None = None,
    token_label: str = "",
) -> IndexJob:
    job = IndexJob(
        site_id=site.id,
        url_id=page.id if page else None,
        target=target,
        job_type=job_type,
        engine=Engine.GOOGLE,
        status=JobStatus.RUNNING,
        triggered_by=triggered_by,
    )
    db.add(job)
    db.flush()

    started = time.perf_counter()
    try:
        if quota.remaining(db, workspace) <= 0:
            job.status = JobStatus.SKIPPED
            job.message = "Wyczerpany dzienny limit zgloszen do Google Indexing API."
            return job

        if token is None:
            token, token_label = resolve_indexing_token(db, user, workspace)

        response = indexing.publish_url(token, target, job_type.value)
        quota.consume(db, workspace.id, 1, Engine.GOOGLE)

        job.status = JobStatus.SUCCESS
        job.message = "Zgloszono do Google Indexing API"
        job.payload = {"response": response, "credential": token_label}

        if page is not None:
            page.last_submitted_at = _now()
            page.submit_count = (page.submit_count or 0) + 1
    except GoogleApiError as exc:
        job.status = JobStatus.FAILED
        job.message = str(exc)
        job.payload = {"credential": token_label, "error": exc.payload}
    finally:
        job.duration_ms = round((time.perf_counter() - started) * 1000, 1)
        job.finished_at = _now()
        db.commit()
    return job


def submit_batch(
    db: Session,
    user: User,
    workspace: Workspace,
    site: Site,
    pages: list[PageUrl],
    job_type: JobType = JobType.URL_UPDATED,
    triggered_by: str = "manual",
) -> dict:
    summary = {"submitted": 0, "failed": 0, "skipped": 0, "messages": []}
    if not pages:
        return summary

    try:
        token, token_label = resolve_indexing_token(db, user, workspace)
    except GoogleApiError as exc:
        summary["failed"] = len(pages)
        summary["messages"].append(str(exc))
        return summary

    for page in pages:
        job = submit_single(
            db,
            user,
            workspace,
            site,
            page,
            page.url,
            job_type=job_type,
            triggered_by=triggered_by,
            token=token,
            token_label=token_label,
        )
        if job.status == JobStatus.SUCCESS:
            summary["submitted"] += 1
        elif job.status == JobStatus.SKIPPED:
            summary["skipped"] += 1
            summary["messages"].append(job.message or "")
            break
        else:
            summary["failed"] += 1
            if job.message:
                summary["messages"].append(job.message)
            if "quota" in (job.message or "").lower() or "429" in (job.message or ""):
                break
        time.sleep(settings.api_throttle_seconds)

    site.last_index_run_at = _now()
    record_site_snapshot(db, site, submitted=summary["submitted"])
    db.commit()
    return summary


# --------------------------------------------------------------- indexnow


def submit_indexnow(db: Session, site: Site, urls: list[str]) -> dict:
    if not site.indexnow_key:
        return {"ok": False, "message": "Brak klucza IndexNow dla tej strony."}
    if not urls:
        return {"ok": False, "message": "Brak URL-i do zgloszenia."}

    key_location = indexnow.key_file_url(site.home_url, site.indexnow_key)
    job = IndexJob(
        site_id=site.id,
        target=f"{len(urls)} URL-i",
        job_type=JobType.INDEXNOW,
        engine=Engine.BING,
        status=JobStatus.RUNNING,
    )
    db.add(job)
    db.flush()

    try:
        result = indexnow.submit_urls(urls, site.indexnow_key, key_location)
        job.status = JobStatus.SUCCESS if result.get("ok") else JobStatus.FAILED
        job.message = f"{result.get('message')} ({result.get('count')} URL-i)"
        job.payload = result
        return result
    except GoogleApiError as exc:
        job.status = JobStatus.FAILED
        job.message = str(exc)
        return {"ok": False, "message": str(exc)}
    finally:
        job.finished_at = _now()
        db.commit()


# ---------------------------------------------------------------- pipeline


def run_site_pipeline(
    db: Session,
    user: User,
    workspace: Workspace,
    site: Site,
    triggered_by: str = "auto",
    scan_sitemaps: bool = True,
) -> dict:
    """Full cycle for one site: refresh URLs, inspect, submit what is missing."""
    from app.services.sitemaps import scan_all_sitemaps

    report: dict = {"site": site.display_name}

    if scan_sitemaps:
        try:
            report["scan"] = scan_all_sitemaps(db, site)
        except Exception as exc:  # noqa: BLE001 - keep the pipeline alive
            report["scan"] = {"error": str(exc)}
            logger.exception("Sitemap scan failed for %s", site.display_name)

    try:
        report["inspection"] = inspect_batch(
            db, user, site, settings.inspection_batch_size, triggered_by
        )
    except GoogleApiError as exc:
        report["inspection"] = {"error": str(exc)}

    budget = min(site.daily_limit, quota.remaining(db, workspace))
    if budget <= 0:
        report["submission"] = {"skipped": True, "reason": "Brak dostepnego limitu na dzis."}
        return report

    pages = pick_urls_for_submission(db, site, budget)
    report["submission"] = submit_batch(
        db, user, workspace, site, pages, triggered_by=triggered_by
    )

    if site.indexnow_enabled and pages:
        report["indexnow"] = submit_indexnow(db, site, [p.url for p in pages])

    log_event(
        db,
        f"Auto-indeksowanie {site.display_name}: "
        f"zgloszono {report['submission'].get('submitted', 0)} URL-i.",
        workspace_id=workspace.id,
        category="indexing",
        details=report,
        commit=True,
    )
    return report
