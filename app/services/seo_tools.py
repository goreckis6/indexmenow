from __future__ import annotations

import time
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from app.services.sitemap_parser import USER_AGENT

TIMEOUT = httpx.Timeout(20.0, connect=8.0)


def fetch_page_meta(url: str) -> dict:
    started = time.perf_counter()
    try:
        with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
            response = client.get(url, headers={"User-Agent": USER_AGENT})
    except httpx.HTTPError as exc:
        return {"url": url, "error": f"Nie udalo sie pobrac strony: {exc}"}

    elapsed_ms = round((time.perf_counter() - started) * 1000)
    soup = BeautifulSoup(response.text, "html.parser")

    def meta(name: str, attr: str = "name") -> str | None:
        tag = soup.find("meta", attrs={attr: name})
        return (tag.get("content") or "").strip() if tag and tag.get("content") else None

    canonical_tag = soup.find("link", rel=lambda v: v and "canonical" in v)
    icon_tag = soup.find("link", rel=lambda v: v and "icon" in (v if isinstance(v, str) else " ".join(v)).lower())
    title_tag = soup.find("title")
    h1_tag = soup.find("h1")

    og_image = meta("og:image", "property")
    if og_image:
        og_image = urljoin(str(response.url), og_image)
    twitter_image = meta("twitter:image", "name") or meta("twitter:image", "property")
    if twitter_image:
        twitter_image = urljoin(str(response.url), twitter_image)

    return {
        "url": url,
        "final_url": str(response.url),
        "status_code": response.status_code,
        "elapsed_ms": elapsed_ms,
        "size_kb": round(len(response.content) / 1024, 1),
        "title": title_tag.get_text(strip=True) if title_tag else None,
        "description": meta("description"),
        "robots": meta("robots"),
        "canonical": canonical_tag.get("href") if canonical_tag else None,
        "favicon": urljoin(str(response.url), icon_tag.get("href")) if icon_tag and icon_tag.get("href") else None,
        "h1": h1_tag.get_text(strip=True) if h1_tag else None,
        "lang": (soup.html.get("lang") if soup.html else None),
        "og": {
            "title": meta("og:title", "property"),
            "description": meta("og:description", "property"),
            "image": og_image,
            "site_name": meta("og:site_name", "property"),
            "type": meta("og:type", "property"),
            "url": meta("og:url", "property"),
        },
        "twitter": {
            "card": meta("twitter:card"),
            "title": meta("twitter:title"),
            "description": meta("twitter:description"),
            "image": twitter_image,
            "site": meta("twitter:site"),
        },
        "issues": _collect_issues(soup, meta, title_tag, canonical_tag, response),
    }


def _collect_issues(soup, meta, title_tag, canonical_tag, response) -> list[dict]:
    issues: list[dict] = []

    if response.status_code >= 400:
        issues.append({"level": "error", "text": f"Strona zwraca kod HTTP {response.status_code}."})

    title = title_tag.get_text(strip=True) if title_tag else ""
    if not title:
        issues.append({"level": "error", "text": "Brak znacznika <title>."})
    elif len(title) > 60:
        issues.append({"level": "warning", "text": f"Tytul ma {len(title)} znakow - Google utnie go w wynikach."})
    elif len(title) < 20:
        issues.append({"level": "warning", "text": "Tytul jest bardzo krotki (<20 znakow)."})

    description = meta("description") or ""
    if not description:
        issues.append({"level": "warning", "text": "Brak meta description."})
    elif len(description) > 160:
        issues.append({"level": "warning", "text": f"Opis ma {len(description)} znakow - zalecane do 160."})

    robots = (meta("robots") or "").lower()
    if "noindex" in robots:
        issues.append({"level": "error", "text": "Strona ma dyrektywe noindex - Google jej nie zaindeksuje."})
    if "nofollow" in robots:
        issues.append({"level": "warning", "text": "Strona ma dyrektywe nofollow."})

    if not canonical_tag:
        issues.append({"level": "warning", "text": "Brak tagu canonical."})

    if not meta("og:image", "property"):
        issues.append({"level": "info", "text": "Brak og:image - linki nie beda mialy podgladu grafiki."})
    if not soup.find("h1"):
        issues.append({"level": "warning", "text": "Brak naglowka H1."})

    if not issues:
        issues.append({"level": "success", "text": "Nie wykryto podstawowych problemow SEO."})
    return issues
