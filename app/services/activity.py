from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models import ActivityLog

logger = logging.getLogger("indexmeplease.activity")


def log_event(
    db: Session,
    message: str,
    *,
    workspace_id: int | None = None,
    level: str = "info",
    category: str = "system",
    details: dict | None = None,
    commit: bool = False,
) -> ActivityLog:
    entry = ActivityLog(
        workspace_id=workspace_id,
        level=level,
        category=category,
        message=message,
        details=details,
    )
    db.add(entry)
    if commit:
        db.commit()
    else:
        db.flush()
    logger.log(logging.WARNING if level in ("warning", "error") else logging.INFO, message)
    return entry
