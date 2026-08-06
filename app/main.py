from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.config import BASE_DIR, settings
from app.database import init_db
from app.deps import LoginRequired, redirect_to_login
from app.routers import api, auth, dashboard, history, settings_router, sites, tools, urls
from app.services.scheduler import shutdown_scheduler, start_scheduler
from app.templating import render

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
)
logger = logging.getLogger("indexmeplease")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    start_scheduler()
    logger.info("%s dziala na %s", settings.app_name, settings.base_url)
    if not settings.google_configured:
        logger.warning(
            "Brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET w .env - logowanie bedzie niedostepne."
        )
    yield
    shutdown_scheduler()


app = FastAPI(
    title=settings.app_name,
    description="Panel do przyspieszania indeksowania stron w Google, Bing, Yandex i Seznam.",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    session_cookie="imp_session",
    max_age=60 * 60 * 24 * 30,
    same_site="lax",
    https_only=False,
)

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "app" / "static")), name="static")

app.include_router(auth.router)
app.include_router(dashboard.router)
app.include_router(sites.router)
app.include_router(urls.router)
app.include_router(history.router)
app.include_router(settings_router.router)
app.include_router(tools.router)
app.include_router(api.router)


@app.exception_handler(LoginRequired)
async def login_required_handler(request: Request, _exc: LoginRequired):
    return redirect_to_login(request)


@app.exception_handler(404)
async def not_found_handler(request: Request, _exc):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": "Nie znaleziono"}, status_code=404)
    return render(request, "errors/404.html", {}, status_code=404)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if request.url.path.startswith("/api/") or exc.status_code == 401:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    return render(
        request,
        "errors/generic.html",
        {"status_code": exc.status_code, "detail": exc.detail},
        status_code=exc.status_code,
    )


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"status": "ok", "app": settings.app_name, "version": app.version}
