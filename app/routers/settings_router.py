from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.config import settings as app_settings
from app.deps import CurrentUser, CurrentWorkspace, DbSession, flash
from app.google import oauth
from app.google import search_console as gsc
from app.google.errors import GoogleApiError
from app.google.service_account import (
    get_service_account_token,
    parse_service_account_json,
)
from app.models import ServiceAccount, Site
from app.security import encrypt
from app.services import quota
from app.services.scheduler import next_run_times, running_tasks
from app.services.workspaces import create_workspace, list_workspaces
from app.templating import render

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
def settings_page(
    request: Request, user: CurrentUser, workspace: CurrentWorkspace, db: DbSession
):
    accounts = list(
        db.scalars(
            select(ServiceAccount)
            .where(ServiceAccount.workspace_id == workspace.id)
            .order_by(ServiceAccount.id)
        )
    )
    return render(
        request,
        "settings.html",
        {
            "user": user,
            "workspace": workspace,
            "workspaces": list_workspaces(db, user),
            "service_accounts": accounts,
            "scopes": user.credential.scope_list if user.credential else [],
            "required_scopes": oauth.SCOPES,
            "quota_used": quota.get_usage(db, workspace.id),
            "quota_history": quota.usage_history(db, workspace.id, 14),
            "next_runs": next_run_times(),
            "running": running_tasks(),
            "site_count": db.scalar(
                select(Site).where(Site.workspace_id == workspace.id).exists().select()
            ),
            "app_settings": app_settings,
            "active_page": "settings",
        },
    )


@router.post("/workspace")
def update_workspace(
    request: Request,
    workspace: CurrentWorkspace,
    db: DbSession,
    name: str = Form(...),
    daily_quota: int = Form(200),
    auto_index_enabled: bool = Form(False),
):
    workspace.name = name.strip()[:120] or workspace.name
    workspace.daily_quota = max(0, min(daily_quota, 100_000))
    workspace.auto_index_enabled = auto_index_enabled
    db.commit()
    flash(request, "Ustawienia workspace zapisane.", "success")
    return RedirectResponse("/settings", status_code=303)


@router.post("/workspace/create")
def new_workspace(
    request: Request, user: CurrentUser, db: DbSession, name: str = Form(...)
):
    workspace = create_workspace(db, user, name)
    request.session["workspace_id"] = workspace.id
    flash(request, f"Utworzono workspace {workspace.name}.", "success")
    return RedirectResponse("/settings", status_code=303)


@router.post("/workspace/switch")
def switch_workspace(
    request: Request, user: CurrentUser, db: DbSession, workspace_id: int = Form(...)
):
    target = next((w for w in list_workspaces(db, user) if w.id == workspace_id), None)
    if target is None:
        flash(request, "Nie znaleziono workspace.", "error")
    else:
        request.session["workspace_id"] = target.id
        flash(request, f"Przelaczono na {target.name}.", "success")
    return RedirectResponse("/", status_code=303)


@router.post("/service-account")
def upload_service_account(
    request: Request,
    workspace: CurrentWorkspace,
    db: DbSession,
    file: Annotated[UploadFile, File()],
    label: str = Form(""),
    daily_quota: int = Form(200),
):
    try:
        raw = file.file.read()
        info = parse_service_account_json(raw)
        get_service_account_token(info)
    except GoogleApiError as exc:
        flash(request, f"Nie udalo sie dodac konta serwisowego: {exc}", "error")
        return RedirectResponse("/settings", status_code=303)

    existing = db.scalar(
        select(ServiceAccount).where(
            ServiceAccount.workspace_id == workspace.id,
            ServiceAccount.client_email == info["client_email"],
        )
    )
    if existing is not None:
        flash(request, "To konto serwisowe jest juz dodane.", "warning")
        return RedirectResponse("/settings", status_code=303)

    account = ServiceAccount(
        workspace_id=workspace.id,
        name=label.strip() or info["client_email"].split("@")[0],
        client_email=info["client_email"],
        project_id=info.get("project_id"),
        private_key_id=info.get("private_key_id"),
        private_key_enc=encrypt(info["private_key"]),
        daily_quota=max(1, daily_quota),
    )
    db.add(account)
    db.commit()
    flash(
        request,
        f"Dodano konto serwisowe {account.client_email}. "
        "Pamietaj, aby dodac je jako wlasciciela w Google Search Console.",
        "success",
    )
    return RedirectResponse("/settings", status_code=303)


@router.post("/service-account/{account_id}/toggle")
def toggle_service_account(
    request: Request, account_id: int, workspace: CurrentWorkspace, db: DbSession
):
    account = db.get(ServiceAccount, account_id)
    if account is None or account.workspace_id != workspace.id:
        flash(request, "Nie znaleziono konta serwisowego.", "error")
    else:
        account.is_active = not account.is_active
        db.commit()
        flash(
            request,
            f"Konto {account.client_email} zostalo "
            f"{'wlaczone' if account.is_active else 'wylaczone'}.",
            "success",
        )
    return RedirectResponse("/settings", status_code=303)


@router.post("/service-account/{account_id}/delete")
def delete_service_account(
    request: Request, account_id: int, workspace: CurrentWorkspace, db: DbSession
):
    account = db.get(ServiceAccount, account_id)
    if account is None or account.workspace_id != workspace.id:
        flash(request, "Nie znaleziono konta serwisowego.", "error")
    else:
        db.delete(account)
        db.commit()
        flash(request, "Konto serwisowe usuniete.", "success")
    return RedirectResponse("/settings", status_code=303)


@router.post("/test-connection")
def test_connection(
    request: Request, user: CurrentUser, workspace: CurrentWorkspace, db: DbSession
):
    try:
        token = oauth.get_access_token(db, user)
        sites = gsc.list_sites(token)
        flash(
            request,
            f"Polaczenie dziala. Konto {user.email} ma dostep do {len(sites)} wlasciwosci "
            "w Search Console.",
            "success",
        )
    except GoogleApiError as exc:
        flash(request, f"Test polaczenia nie powiodl sie: {exc}", "error")
    return RedirectResponse("/settings", status_code=303)
