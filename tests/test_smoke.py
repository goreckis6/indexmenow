"""Testy dymne: sprawdzaja, ze kazdy widok panelu renderuje sie poprawnie.

Uruchomienie:
    .venv\\Scripts\\python.exe -m pytest tests -q
albo bez pytest:
    .venv\\Scripts\\python.exe tests/test_smoke.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TEST_DB = Path(tempfile.gettempdir()) / "imp_test.db"
if TEST_DB.exists():
    TEST_DB.unlink()

os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"
os.environ["SECRET_KEY"] = "test-secret-key-for-smoke-tests"
os.environ["BASE_URL"] = "http://127.0.0.1:8006"
os.environ["GOOGLE_CLIENT_ID"] = "test-client-id"
os.environ["GOOGLE_CLIENT_SECRET"] = "test-client-secret"

from datetime import datetime, timedelta, timezone  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from app.database import SessionLocal, init_db  # noqa: E402
from app.deps import get_optional_user  # noqa: E402
from app.main import app  # noqa: E402
from app.models import IndexJob, IndexStatus, PageUrl, Site, Sitemap, User  # noqa: E402
from app.services.indexer import map_index_status  # noqa: E402
from app.services.sitemap_parser import parse_sitemap_xml  # noqa: E402
from app.services.sites import property_to_home_url, normalize_property  # noqa: E402
from app.services.urls import normalize_url, parse_url_blob  # noqa: E402
from app.services.workspaces import create_default_workspace  # noqa: E402


def seed():
    init_db()
    db = SessionLocal()
    user = User(google_sub="sub-123", email="tester@example.com", name="Tester", is_admin=True)
    db.add(user)
    db.commit()
    db.refresh(user)

    workspace = create_default_workspace(db, user)

    site = Site(
        workspace_id=workspace.id,
        property_url="sc-domain:example.com",
        display_name="example.com",
        home_url="https://example.com/",
        permission_level="siteOwner",
        indexnow_key="a" * 32,
        auto_index=True,
    )
    db.add(site)
    db.commit()
    db.refresh(site)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    statuses = [
        IndexStatus.INDEXED,
        IndexStatus.INDEXED,
        IndexStatus.NOT_INDEXED,
        IndexStatus.EXCLUDED,
        IndexStatus.UNKNOWN,
    ]
    for i, status in enumerate(statuses):
        db.add(
            PageUrl(
                site_id=site.id,
                url=f"https://example.com/strona-{i}",
                index_status=status,
                coverage_state="Submitted and indexed" if status == IndexStatus.INDEXED else None,
                last_checked_at=now - timedelta(hours=i) if status != IndexStatus.UNKNOWN else None,
                source="sitemap",
            )
        )
    db.add(Sitemap(site_id=site.id, path="https://example.com/sitemap.xml", url_count=5))
    db.add(
        IndexJob(
            site_id=site.id,
            target="https://example.com/strona-2",
            job_type="URL_UPDATED",
            status="SUCCESS",
            message="Zgloszono do Google Indexing API",
        )
    )
    db.commit()
    db.close()
    return user.id, site.id


USER_ID, SITE_ID = seed()


_user_session = SessionLocal()


def _current_user():
    """Mimics the request-scoped lookup; the session stays open so lazy loads work."""
    _user_session.expire_all()
    return _user_session.get(User, USER_ID)


app.dependency_overrides[get_optional_user] = _current_user
client = TestClient(app)


# ------------------------------------------------------------------ helpers


def check(path: str, expect: int = 200) -> str:
    response = client.get(path)
    assert response.status_code == expect, f"{path} -> {response.status_code}\n{response.text[:900]}"
    return response.text


# -------------------------------------------------------------------- tests


def test_pure_helpers():
    assert normalize_url("example.com/a?utm_source=x&id=2") == "https://example.com/a?id=2"
    assert normalize_url("  ") is None
    assert parse_url_blob("https://a.pl/1\nhttps://a.pl/2, https://a.pl/1") == [
        "https://a.pl/1",
        "https://a.pl/2",
    ]
    assert property_to_home_url("sc-domain:example.com") == "https://example.com/"
    assert normalize_property("example.com") == "https://example.com/"
    assert map_index_status("PASS", "Submitted and indexed") == IndexStatus.INDEXED
    assert map_index_status("NEUTRAL", "Crawled - currently not indexed") == IndexStatus.NOT_INDEXED
    assert map_index_status("NEUTRAL", "Excluded by 'noindex' tag") == IndexStatus.EXCLUDED
    print("  helpers: OK")


def test_sitemap_parser():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/a</loc><lastmod>2024-05-01</lastmod><priority>0.8</priority></url>
      <url><loc>https://example.com/b</loc></url>
    </urlset>"""
    result = parse_sitemap_xml(xml, "test")
    assert result.url_count == 2
    assert result.entries[0].url == "https://example.com/a"
    assert result.entries[0].priority == 0.8

    index_xml = b"""<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
    </sitemapindex>"""
    index_result = parse_sitemap_xml(index_xml, "test")
    assert index_result.is_index and index_result.child_sitemaps
    print("  sitemap parser: OK")


def test_health_and_login():
    assert client.get("/healthz").json()["status"] == "ok"
    app.dependency_overrides.pop(get_optional_user)
    anonymous = TestClient(app)
    assert "Kontynuuj z Google" in anonymous.get("/login").text
    assert anonymous.get("/", follow_redirects=False).status_code == 303
    app.dependency_overrides[get_optional_user] = _current_user
    print("  auth: OK")


def test_pages_render():
    dashboard = check("/")
    assert "Pulpit" in dashboard and "example.com" in dashboard

    assert "Wszystkie strony" in check("/sites")
    assert "Adresy URL" in check("/urls")
    assert "Historia zadan" in check("/history")
    assert "Workspace" in check("/settings")
    assert "Szybkie indeksowanie" in check("/tools?tool=instant")
    assert "IndexNow" in check("/tools?tool=indexnow")
    assert "Analizuj" in check("/tools/preview")
    assert "Wczytaj" in check("/tools/sitemap")

    for tab in ("overview", "urls", "sitemaps", "jobs", "settings"):
        assert "example.com" in check(f"/sites/{SITE_ID}?tab={tab}")

    assert "Nie znaleziono" in check("/sites/9999", expect=404)
    csv_body = check("/urls/export.csv")
    assert "strona;url;status" in csv_body
    print("  strony HTML: OK")


def test_api():
    data = client.get("/api/overview").json()
    assert data["urls"]["total"] == 5
    assert data["urls"]["INDEXED"] == 2
    assert data["quota"]["limit"] == 200

    breakdown = client.get("/api/status-breakdown").json()
    assert breakdown["INDEXED"] == 2 and breakdown["EXCLUDED"] == 1

    tasks = client.get("/api/tasks").json()
    assert "running" in tasks and isinstance(tasks["recent"], list)

    summary = client.get(f"/api/sites/{SITE_ID}/summary").json()
    assert summary["stats"]["coverage"] == 50.0
    print("  API JSON: OK")


def test_mutations():
    response = client.post(
        "/urls/add",
        data={
            "site_id": SITE_ID,
            "urls_blob": "https://example.com/nowa-1\nhttps://example.com/nowa-2\nhttps://inna.pl/x",
            "priority": "10",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert client.get("/api/overview").json()["urls"]["total"] == 7

    db = SessionLocal()
    new_id = (
        db.query(PageUrl).filter(PageUrl.url == "https://example.com/nowa-1").first().id
    )
    db.close()

    response = client.post(
        "/urls/action",
        data={"action": "delete", "url_ids": [new_id], "redirect_to": "/urls"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert client.get("/api/overview").json()["urls"]["total"] == 6

    response = client.post(
        f"/sites/{SITE_ID}/settings",
        data={"display_name": "example.com", "daily_limit": "120", "priority": "5",
              "auto_index": "on", "indexnow_enabled": "on", "is_active": "on"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert client.get(f"/api/sites/{SITE_ID}/summary").json()["auto_index"] is True

    response = client.post(
        "/settings/workspace",
        data={"name": "Testowy workspace", "daily_quota": "500", "auto_index_enabled": "on"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert client.get("/api/overview").json()["quota"]["limit"] == 500
    print("  formularze i akcje: OK")


if __name__ == "__main__":
    print("\nIndexMePlease - testy dymne\n" + "-" * 40)
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
            except AssertionError as exc:
                failures += 1
                print(f"  {name}: FAIL\n{exc}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"  {name}: ERROR {type(exc).__name__}: {exc}")
    print("-" * 40)
    print("Wszystko dziala." if not failures else f"Bledy: {failures}")
    sys.exit(1 if failures else 0)
