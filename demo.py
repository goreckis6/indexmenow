"""Tryb demo - panel z przykladowymi danymi, bez logowania Google.

Sluzy wylacznie do obejrzenia interfejsu zanim skonfigurujesz OAuth.
Uruchamia sie na osobnej bazie (data/demo.db) i NIE dotyka danych produkcyjnych.

    py demo.py            # http://127.0.0.1:8007
    py demo.py --lan      # dostepne rowniez z innych urzadzen w sieci

Uwaga: w tym trybie kazdy, kto otworzy adres, jest zalogowany jako uzytkownik
demo. Nie zostawiaj go uruchomionego na stale.
"""

from __future__ import annotations

import os
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

(ROOT / "data").mkdir(exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite:///{(ROOT / 'data' / 'demo.db').as_posix()}"
os.environ.setdefault("SECRET_KEY", "demo-secret-key-not-for-production")
os.environ["PORT"] = os.environ.get("DEMO_PORT", "8007")

from datetime import date, datetime, timedelta, timezone  # noqa: E402

import uvicorn  # noqa: E402

from app.database import SessionLocal, init_db  # noqa: E402
from app.deps import get_optional_user  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    ActivityLog,
    IndexJob,
    IndexStatus,
    PageUrl,
    QuotaUsage,
    Site,
    Sitemap,
    SiteStat,
    User,
    Workspace,
)
from app.services.workspaces import create_default_workspace  # noqa: E402

NOW = datetime.now(timezone.utc).replace(tzinfo=None)

DEMO_SITES = [
    ("sc-domain:sklep-rowerowy.pl", "sklep-rowerowy.pl", 420, 0.82),
    ("https://blog-kulinarny.pl/", "blog-kulinarny.pl", 168, 0.61),
    ("sc-domain:kancelaria-nowak.pl", "kancelaria-nowak.pl", 47, 0.94),
]

SLUGS = [
    "oferta", "kontakt", "o-nas", "blog/jak-wybrac-rower", "kategoria/szosowe",
    "kategoria/gorskie", "produkt/kask-abus", "produkt/lampka-led", "regulamin",
    "dostawa-i-zwroty", "blog/serwis-lancucha", "blog/przeglad-sezonowy",
    "promocje", "nowosci", "opinie", "faq", "blog/trasy-w-polsce",
]

COVERAGE_TEXT = {
    IndexStatus.INDEXED: "Submitted and indexed",
    IndexStatus.NOT_INDEXED: "Crawled - currently not indexed",
    IndexStatus.EXCLUDED: "Duplicate, Google chose different canonical than user",
    IndexStatus.UNKNOWN: None,
}


def seed() -> int:
    init_db()
    db = SessionLocal()
    if db.query(User).count():
        user = db.query(User).first()
        db.close()
        return user.id

    random.seed(7)
    user = User(
        google_sub="demo-sub",
        email="demo@indexmeplease.local",
        name="Konto demo",
        is_admin=True,
        last_login_at=NOW,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    workspace: Workspace = create_default_workspace(db, user)
    workspace.name = "Agencja SEO"
    workspace.daily_quota = 200
    db.commit()

    for index, (property_url, name, url_count, coverage) in enumerate(DEMO_SITES):
        home = (
            f"https://{property_url.split(':', 1)[1]}/"
            if property_url.startswith("sc-domain:")
            else property_url
        )
        site = Site(
            workspace_id=workspace.id,
            property_url=property_url,
            display_name=name,
            home_url=home,
            permission_level="siteOwner",
            auto_index=index < 2,
            daily_limit=[80, 50, 20][index],
            priority=[10, 5, 0][index],
            indexnow_key="%032x" % random.getrandbits(128),
            indexnow_enabled=index == 0,
            last_scan_at=NOW - timedelta(hours=index * 5 + 2),
            last_index_run_at=NOW - timedelta(hours=index * 7 + 1),
        )
        db.add(site)
        db.commit()
        db.refresh(site)

        db.add(
            Sitemap(
                site_id=site.id,
                path=f"{home}sitemap.xml",
                source="gsc",
                url_count=url_count,
                is_sitemaps_index=index == 0,
                last_submitted_at=NOW - timedelta(days=index + 1),
                last_downloaded_at=NOW - timedelta(hours=index * 4 + 3),
            )
        )
        if index == 0:
            db.add(
                Sitemap(
                    site_id=site.id, path=f"{home}sitemap-produkty.xml",
                    source="gsc", url_count=310, warnings=2,
                    last_downloaded_at=NOW - timedelta(hours=6),
                )
            )

        for i in range(min(url_count, 60)):
            slug = SLUGS[i % len(SLUGS)] if i < len(SLUGS) else f"produkt/pozycja-{i}"
            roll = random.random()
            if roll < coverage:
                status = IndexStatus.INDEXED
            elif roll < coverage + 0.18:
                status = IndexStatus.NOT_INDEXED
            elif roll < coverage + 0.26:
                status = IndexStatus.EXCLUDED
            else:
                status = IndexStatus.UNKNOWN

            checked = None if status == IndexStatus.UNKNOWN else NOW - timedelta(hours=random.randint(1, 140))
            db.add(
                PageUrl(
                    site_id=site.id,
                    url=f"{home}{slug}",
                    source="sitemap" if i % 4 else "manual",
                    index_status=status,
                    coverage_state=COVERAGE_TEXT[status],
                    verdict="PASS" if status == IndexStatus.INDEXED else "NEUTRAL",
                    robots_state="ALLOWED",
                    page_fetch_state="SUCCESSFUL",
                    last_checked_at=checked,
                    last_crawl_at=checked - timedelta(days=random.randint(1, 20)) if checked else None,
                    last_submitted_at=NOW - timedelta(hours=random.randint(2, 200))
                    if status != IndexStatus.INDEXED and random.random() > 0.4
                    else None,
                    submit_count=random.randint(0, 3),
                    priority=10 if i < 2 else 0,
                )
            )
        db.commit()

        for day_offset in range(29, -1, -1):
            day = date.today() - timedelta(days=day_offset)
            progress = (30 - day_offset) / 30
            total = int(url_count * (0.55 + 0.45 * progress))
            indexed = int(total * (coverage - 0.25 + 0.25 * progress))
            db.add(
                SiteStat(
                    site_id=site.id, day=day, total_urls=total, indexed=indexed,
                    not_indexed=total - indexed,
                    submitted=random.randint(0, 24), inspected=random.randint(4, 50),
                )
            )
        db.commit()

        for i in range(18):
            failed = random.random() < 0.16
            created = NOW - timedelta(hours=i * 5 + index)
            db.add(
                IndexJob(
                    site_id=site.id,
                    target=f"{home}{SLUGS[i % len(SLUGS)]}",
                    job_type=random.choice(["URL_UPDATED", "INSPECT", "URL_UPDATED", "INDEXNOW"]),
                    status="FAILED" if failed else "SUCCESS",
                    triggered_by="auto" if i % 3 else "manual",
                    message="Permission denied. Failed to verify the URL ownership."
                    if failed
                    else "Zgloszono do Google Indexing API",
                    duration_ms=random.uniform(180, 1400),
                    created_at=created,
                    finished_at=created + timedelta(seconds=1),
                )
            )
        db.commit()

    for day_offset in range(13, -1, -1):
        db.add(
            QuotaUsage(
                workspace_id=workspace.id,
                day=date.today() - timedelta(days=day_offset),
                engine="google",
                used=random.randint(40, 195),
            )
        )
    for i, (message, level, category) in enumerate([
        ("Auto-indeksowanie sklep-rowerowy.pl: zgloszono 74 URL-i.", "info", "indexing"),
        ("Skan sitemap dla blog-kulinarny.pl: +12 nowych URL-i.", "info", "sitemap"),
        ("Inspekcja kancelaria-nowak.pl: sprawdzono 40 URL-i (37 zaindeksowanych).", "info", "inspection"),
        ("Dzienny limit zgloszen zostal wyczerpany o 14:20.", "warning", "indexing"),
        ("Zaimportowano strony z Search Console: 3 nowe.", "info", "sites"),
    ]):
        db.add(
            ActivityLog(
                workspace_id=workspace.id, level=level, category=category,
                message=message, created_at=NOW - timedelta(hours=i * 3 + 1),
            )
        )
    db.commit()

    user_id = user.id
    db.close()
    return user_id


DEMO_USER_ID = seed()
_session = SessionLocal()


def _demo_user():
    _session.expire_all()
    return _session.get(User, DEMO_USER_ID)


app.dependency_overrides[get_optional_user] = _demo_user


if __name__ == "__main__":
    host = "0.0.0.0" if "--lan" in sys.argv else "127.0.0.1"
    port = int(os.environ["PORT"])
    print()
    print("  IndexMePlease — TRYB DEMO (bez logowania, dane przykladowe)")
    print(f"  http://127.0.0.1:{port}")
    print("  " + "-" * 52)
    print()
    uvicorn.run(app, host=host, port=port, log_level="warning")
