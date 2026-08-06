from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select

from app.config import settings
from app.deps import DbSession, OptionalUser, flash
from app.google import oauth
from app.google.errors import GoogleApiError
from app.models import User
from app.security import decrypt, generate_state
from app.services.activity import log_event
from app.services.workspaces import create_default_workspace
from app.templating import render

logger = logging.getLogger("indexmeplease.auth")
router = APIRouter(tags=["auth"])


@router.get("/login")
def login_page(request: Request, user: OptionalUser):
    if user is not None:
        return RedirectResponse("/", status_code=303)
    return render(
        request,
        "login.html",
        {
            "google_configured": settings.google_configured,
            "redirect_uri": settings.redirect_uri,
            "next": request.query_params.get("next", "/"),
        },
    )


@router.get("/auth/google")
def start_oauth(request: Request):
    if not settings.google_configured:
        flash(request, "Brak konfiguracji Google OAuth w pliku .env", "error")
        return RedirectResponse("/login", status_code=303)

    state = generate_state()
    request.session["oauth_state"] = state
    request.session["oauth_next"] = request.query_params.get("next", "/")
    return RedirectResponse(oauth.build_authorization_url(state), status_code=303)


@router.get("/auth/callback")
def oauth_callback(request: Request, db: DbSession):
    error = request.query_params.get("error")
    if error:
        flash(request, f"Logowanie anulowane: {error}", "error")
        return RedirectResponse("/login", status_code=303)

    code = request.query_params.get("code")
    state = request.query_params.get("state")
    expected_state = request.session.pop("oauth_state", None)

    if not code or not state or state != expected_state:
        flash(request, "Nieprawidlowy stan logowania. Sprobuj ponownie.", "error")
        return RedirectResponse("/login", status_code=303)

    try:
        token_data = oauth.exchange_code(code)
        profile = oauth.fetch_userinfo(token_data["access_token"])
    except GoogleApiError as exc:
        logger.error("OAuth failed: %s", exc)
        flash(request, f"Blad logowania Google: {exc}", "error")
        return RedirectResponse("/login", status_code=303)

    email = (profile.get("email") or "").lower()
    if not email:
        flash(request, "Konto Google nie udostepnilo adresu e-mail.", "error")
        return RedirectResponse("/login", status_code=303)

    allowed = settings.allowed_email_list
    if allowed and email not in allowed:
        flash(request, f"Konto {email} nie ma dostepu do tego panelu.", "error")
        return RedirectResponse("/login", status_code=303)

    user = db.scalar(select(User).where(User.google_sub == profile["sub"]))
    if user is None:
        user = db.scalar(select(User).where(User.email == email))

    is_first_user = db.scalar(select(func.count(User.id))) == 0

    if user is None:
        user = User(
            google_sub=profile["sub"],
            email=email,
            name=profile.get("name"),
            picture=profile.get("picture"),
            locale=profile.get("locale"),
            is_admin=is_first_user,
        )
        db.add(user)
        db.flush()
        created = True
    else:
        user.email = email
        user.name = profile.get("name") or user.name
        user.picture = profile.get("picture") or user.picture
        user.google_sub = profile["sub"]
        created = False

    if not user.is_active:
        flash(request, "To konto zostalo zablokowane przez administratora.", "error")
        return RedirectResponse("/login", status_code=303)

    user.last_login_at = datetime.now(timezone.utc).replace(tzinfo=None)
    oauth.store_credentials(db, user, token_data)
    db.commit()
    db.refresh(user)

    if not user.workspaces:
        create_default_workspace(db, user)
        db.refresh(user)

    request.session["user_id"] = user.id
    request.session["workspace_id"] = user.workspaces[0].id

    granted = token_data.get("scope", "")
    missing = [s for s in oauth.SCOPES if s.startswith("https://") and s not in granted]
    if missing:
        flash(
            request,
            "Nie przyznano wszystkich uprawnien - indeksowanie moze nie dzialac. "
            "Wyloguj sie i zaloguj ponownie zaznaczajac wszystkie zgody.",
            "warning",
        )

    log_event(
        db,
        f"{'Nowe konto' if created else 'Logowanie'}: {email}",
        workspace_id=user.workspaces[0].id if user.workspaces else None,
        category="auth",
        commit=True,
    )
    flash(request, f"Zalogowano jako {user.name or email}.", "success")

    next_url = request.session.pop("oauth_next", "/") or "/"
    if not next_url.startswith("/"):
        next_url = "/"
    return RedirectResponse(next_url, status_code=303)


@router.get("/logout")
@router.post("/logout")
def logout(request: Request, user: OptionalUser, db: DbSession):
    if user is not None and user.credential is not None:
        token = decrypt(user.credential.access_token_enc)
        if token and request.query_params.get("revoke") == "1":
            oauth.revoke_token(token)
            db.delete(user.credential)
            db.commit()
    request.session.clear()
    flash(request, "Wylogowano.", "success")
    return RedirectResponse("/login", status_code=303)
