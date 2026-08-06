from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import User, Workspace


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "workspace"


def create_workspace(db: Session, user: User, name: str) -> Workspace:
    base_slug = slugify(name)
    slug = base_slug
    counter = 2
    while db.scalar(select(Workspace).where(Workspace.slug == slug)) is not None:
        slug = f"{base_slug}-{counter}"
        counter += 1

    workspace = Workspace(
        user_id=user.id,
        name=name.strip()[:120] or "Moj workspace",
        slug=slug,
        daily_quota=settings.default_daily_quota,
    )
    db.add(workspace)
    db.commit()
    db.refresh(workspace)
    return workspace


def create_default_workspace(db: Session, user: User) -> Workspace:
    label = (user.name or user.email.split("@")[0]).strip()
    return create_workspace(db, user, f"Workspace {label}"[:120])


def list_workspaces(db: Session, user: User) -> list[Workspace]:
    return list(
        db.scalars(select(Workspace).where(Workspace.user_id == user.id).order_by(Workspace.id))
    )
