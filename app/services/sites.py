from __future__ import annotations

from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.google import search_console as gsc
from app.google.oauth import get_access_token
from app.models import Site, User, Workspace
from app.security import generate_indexnow_key
from app.services.activity import log_event


def property_to_home_url(property_url: str) -> str:
    if property_url.startswith("sc-domain:"):
        domain = property_url.split(":", 1)[1]
        return f"https://{domain}/"
    return property_url if property_url.endswith("/") else property_url + "/"


def property_to_display_name(property_url: str) -> str:
    if property_url.startswith("sc-domain:"):
        return property_url.split(":", 1)[1]
    parsed = urlparse(property_url)
    path = parsed.path.rstrip("/")
    return f"{parsed.netloc}{path}" if path else parsed.netloc


def normalize_property(raw: str) -> str:
    value = raw.strip()
    if value.startswith("sc-domain:"):
        return "sc-domain:" + value.split(":", 1)[1].strip().lower().removeprefix("www.")
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    parsed = urlparse(value)
    path = parsed.path if parsed.path.endswith("/") else parsed.path + "/"
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def import_sites_from_gsc(db: Session, user: User, workspace: Workspace) -> dict:
    """Pull every Search Console property the user has access to."""
    token = get_access_token(db, user)
    entries = gsc.list_sites(token)

    created = 0
    updated = 0
    skipped = 0

    for entry in entries:
        property_url = entry.get("siteUrl")
        permission = entry.get("permissionLevel", "")
        if not property_url:
            continue
        if permission == "siteUnverifiedUser":
            skipped += 1
            continue

        site = db.scalar(
            select(Site).where(
                Site.workspace_id == workspace.id, Site.property_url == property_url
            )
        )
        if site is None:
            site = Site(
                workspace_id=workspace.id,
                property_url=property_url,
                display_name=property_to_display_name(property_url),
                home_url=property_to_home_url(property_url),
                permission_level=permission,
                indexnow_key=generate_indexnow_key(),
            )
            db.add(site)
            created += 1
        else:
            site.permission_level = permission
            site.home_url = property_to_home_url(property_url)
            updated += 1

    db.commit()
    log_event(
        db,
        f"Zaimportowano strony z Search Console: {created} nowych, {updated} zaktualizowanych.",
        workspace_id=workspace.id,
        category="sites",
        details={"created": created, "updated": updated, "skipped": skipped},
        commit=True,
    )
    return {"created": created, "updated": updated, "skipped": skipped, "total": len(entries)}


def create_site(db: Session, workspace: Workspace, property_url: str) -> Site:
    normalized = normalize_property(property_url)
    existing = db.scalar(
        select(Site).where(Site.workspace_id == workspace.id, Site.property_url == normalized)
    )
    if existing:
        return existing

    site = Site(
        workspace_id=workspace.id,
        property_url=normalized,
        display_name=property_to_display_name(normalized),
        home_url=property_to_home_url(normalized),
        permission_level="manual",
        indexnow_key=generate_indexnow_key(),
    )
    db.add(site)
    db.commit()
    db.refresh(site)
    return site


def verify_site_access(db: Session, user: User, site: Site) -> dict:
    """Confirm the signed-in account still owns the property in Search Console."""
    token = get_access_token(db, user)
    entry = gsc.get_site(token, site.property_url)
    permission = entry.get("permissionLevel")
    if permission:
        site.permission_level = permission
        db.commit()
    return entry


def list_sites(db: Session, workspace: Workspace) -> list[Site]:
    return list(
        db.scalars(
            select(Site)
            .where(Site.workspace_id == workspace.id)
            .order_by(Site.priority.desc(), Site.display_name)
        )
    )
