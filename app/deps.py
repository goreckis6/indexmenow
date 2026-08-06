from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Site, User, Workspace

DbSession = Annotated[Session, Depends(get_db)]


class LoginRequired(Exception):
    """Raised when an HTML page needs an authenticated user."""


def flash(request: Request, message: str, category: str = "success") -> None:
    messages = request.session.setdefault("_flashes", [])
    messages.append({"message": message, "category": category})
    request.session["_flashes"] = messages[-5:]


def pop_flashes(request: Request) -> list[dict]:
    return request.session.pop("_flashes", [])


def get_optional_user(request: Request, db: DbSession) -> User | None:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        request.session.clear()
        return None
    return user


OptionalUser = Annotated[User | None, Depends(get_optional_user)]


def get_current_user(user: OptionalUser) -> User:
    if user is None:
        raise LoginRequired
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_api_user(user: OptionalUser) -> User:
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


ApiUser = Annotated[User, Depends(get_api_user)]


def get_current_workspace(request: Request, user: CurrentUser, db: DbSession) -> Workspace:
    workspace_id = request.session.get("workspace_id")
    workspace = None
    if workspace_id:
        workspace = db.scalar(
            select(Workspace).where(Workspace.id == workspace_id, Workspace.user_id == user.id)
        )
    if workspace is None:
        workspace = db.scalar(
            select(Workspace).where(Workspace.user_id == user.id).order_by(Workspace.id)
        )
    if workspace is None:
        from app.services.workspaces import create_default_workspace

        workspace = create_default_workspace(db, user)
    request.session["workspace_id"] = workspace.id
    return workspace


CurrentWorkspace = Annotated[Workspace, Depends(get_current_workspace)]


def get_site_or_404(db: Session, workspace: Workspace, site_id: int) -> Site:
    site = db.scalar(
        select(Site).where(Site.id == site_id, Site.workspace_id == workspace.id)
    )
    if site is None:
        raise HTTPException(status_code=404, detail="Nie znaleziono strony")
    return site


def redirect_to_login(request: Request) -> RedirectResponse:
    nxt = request.url.path
    target = "/login" if nxt in ("/", "/login") else f"/login?next={nxt}"
    return RedirectResponse(target, status_code=status.HTTP_303_SEE_OTHER)
