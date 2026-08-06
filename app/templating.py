from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Request
from fastapi.templating import Jinja2Templates

from app.config import BASE_DIR, settings
from app.deps import pop_flashes

templates = Jinja2Templates(directory=str(BASE_DIR / "app" / "templates"))

STATUS_LABELS = {
    "INDEXED": "Zaindeksowany",
    "NOT_INDEXED": "Niezaindeksowany",
    "EXCLUDED": "Wykluczony",
    "UNKNOWN": "Nieznany",
    "ERROR": "Blad",
    "PENDING": "Oczekuje",
    "RUNNING": "W trakcie",
    "SUCCESS": "Sukces",
    "FAILED": "Blad",
    "SKIPPED": "Pominiety",
}

STATUS_TONES = {
    "INDEXED": "ok",
    "SUCCESS": "ok",
    "NOT_INDEXED": "warn",
    "PENDING": "warn",
    "RUNNING": "info",
    "EXCLUDED": "muted",
    "SKIPPED": "muted",
    "UNKNOWN": "muted",
    "ERROR": "bad",
    "FAILED": "bad",
}

JOB_TYPE_LABELS = {
    "URL_UPDATED": "Zgloszenie URL",
    "URL_DELETED": "Usuniecie URL",
    "INSPECT": "Inspekcja",
    "SITEMAP_SUBMIT": "Zgloszenie sitemapy",
    "SITEMAP_DELETE": "Usuniecie sitemapy",
    "INDEXNOW": "IndexNow",
}


def fmt_datetime(value: datetime | None, fmt: str = "%d.%m.%Y %H:%M") -> str:
    if value is None:
        return "—"
    return value.strftime(fmt)


def fmt_relative(value: datetime | None) -> str:
    if value is None:
        return "nigdy"
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    delta = now - value
    seconds = int(delta.total_seconds())
    if seconds < 0:
        return "za chwile"
    if seconds < 60:
        return "przed chwila"
    if seconds < 3600:
        return f"{seconds // 60} min temu"
    if seconds < 86400:
        return f"{seconds // 3600} godz. temu"
    days = seconds // 86400
    if days == 1:
        return "wczoraj"
    if days < 30:
        return f"{days} dni temu"
    months = days // 30
    return f"{months} mies. temu" if months < 12 else f"{days // 365} lat temu"


def fmt_number(value) -> str:
    try:
        return f"{int(value):,}".replace(",", " ")
    except (TypeError, ValueError):
        return str(value)


def status_label(value: str | None) -> str:
    return STATUS_LABELS.get(str(value), str(value or "—"))


def status_tone(value: str | None) -> str:
    return STATUS_TONES.get(str(value), "muted")


def job_type_label(value: str | None) -> str:
    return JOB_TYPE_LABELS.get(str(value), str(value or "—"))


def truncate_url(value: str | None, length: int = 60) -> str:
    if not value:
        return "—"
    cleaned = value.replace("https://", "").replace("http://", "")
    return cleaned if len(cleaned) <= length else cleaned[: length - 1] + "…"


templates.env.filters["dt"] = fmt_datetime
templates.env.filters["ago"] = fmt_relative
templates.env.filters["num"] = fmt_number
templates.env.filters["status_label"] = status_label
templates.env.filters["status_tone"] = status_tone
templates.env.filters["job_type"] = job_type_label
templates.env.filters["short_url"] = truncate_url
templates.env.globals["app_name"] = settings.app_name
templates.env.globals["now"] = lambda: datetime.now()


def render(request: Request, template: str, context: dict | None = None, status_code: int = 200):
    payload = {
        "request": request,
        "flashes": pop_flashes(request),
        "settings": settings,
    }
    payload.update(context or {})
    return templates.TemplateResponse(request, template, payload, status_code=status_code)
