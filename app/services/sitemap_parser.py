from __future__ import annotations

import gzip
import io
import re
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urljoin, urlparse

import httpx

USER_AGENT = "IndexMePlease/1.0 (+sitemap-crawler)"
TIMEOUT = httpx.Timeout(30.0, connect=10.0)
MAX_DEPTH = 3
MAX_URLS = 50_000

_NS_RE = re.compile(r"\{[^}]+\}")


@dataclass
class SitemapEntry:
    url: str
    lastmod: datetime | None = None
    priority: float | None = None


@dataclass
class SitemapResult:
    source: str
    entries: list[SitemapEntry] = field(default_factory=list)
    child_sitemaps: list[str] = field(default_factory=list)
    is_index: bool = False
    error: str | None = None

    @property
    def url_count(self) -> int:
        return len(self.entries)


def _strip_ns(tag: str) -> str:
    return _NS_RE.sub("", tag).lower()


def _parse_lastmod(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = value.strip().replace("Z", "+00:00")
    for parser in (
        lambda v: datetime.fromisoformat(v),
        lambda v: datetime.strptime(v[:10], "%Y-%m-%d"),
    ):
        try:
            parsed = parser(raw)
            return parsed.replace(tzinfo=None)
        except (ValueError, TypeError):
            continue
    return None


def fetch_bytes(url: str) -> bytes:
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
        response = client.get(url, headers={"User-Agent": USER_AGENT})
        response.raise_for_status()
        content = response.content

    if url.endswith(".gz") or content[:2] == b"\x1f\x8b":
        with gzip.GzipFile(fileobj=io.BytesIO(content)) as gz:
            content = gz.read()
    return content


def parse_sitemap_xml(content: bytes, source: str) -> SitemapResult:
    from xml.etree import ElementTree as ET  # noqa: N817

    result = SitemapResult(source=source)
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        # Plain-text sitemaps are allowed by the protocol.
        text = content.decode("utf-8", errors="ignore")
        lines = [line.strip() for line in text.splitlines() if line.strip().startswith("http")]
        if lines:
            result.entries = [SitemapEntry(url=line) for line in lines]
            return result
        result.error = f"Nie udalo sie sparsowac XML: {exc}"
        return result

    root_tag = _strip_ns(root.tag)
    result.is_index = root_tag == "sitemapindex"

    for child in root:
        tag = _strip_ns(child.tag)
        loc = None
        lastmod = None
        priority = None
        for sub in child:
            sub_tag = _strip_ns(sub.tag)
            if sub_tag == "loc":
                loc = (sub.text or "").strip()
            elif sub_tag == "lastmod":
                lastmod = _parse_lastmod(sub.text)
            elif sub_tag == "priority":
                try:
                    priority = float((sub.text or "").strip())
                except ValueError:
                    priority = None
        if not loc:
            continue
        if tag == "sitemap":
            result.child_sitemaps.append(loc)
        elif tag == "url":
            result.entries.append(SitemapEntry(url=loc, lastmod=lastmod, priority=priority))

    return result


def crawl_sitemap(url: str, depth: int = 0, seen: set[str] | None = None) -> SitemapResult:
    """Fetch a sitemap and recursively expand sitemap index files."""
    seen = seen if seen is not None else set()
    aggregate = SitemapResult(source=url)

    if url in seen or depth > MAX_DEPTH:
        return aggregate
    seen.add(url)

    try:
        content = fetch_bytes(url)
    except httpx.HTTPStatusError as exc:
        aggregate.error = f"HTTP {exc.response.status_code} przy pobieraniu {url}"
        return aggregate
    except httpx.HTTPError as exc:
        aggregate.error = f"Blad pobierania {url}: {exc}"
        return aggregate

    parsed = parse_sitemap_xml(content, url)
    aggregate.error = parsed.error
    aggregate.is_index = parsed.is_index
    aggregate.entries.extend(parsed.entries)
    aggregate.child_sitemaps.extend(parsed.child_sitemaps)

    for child_url in parsed.child_sitemaps:
        if len(aggregate.entries) >= MAX_URLS:
            break
        child = crawl_sitemap(child_url, depth + 1, seen)
        aggregate.entries.extend(child.entries)

    # De-duplicate while preserving order.
    unique: dict[str, SitemapEntry] = {}
    for entry in aggregate.entries:
        unique.setdefault(entry.url, entry)
    aggregate.entries = list(unique.values())[:MAX_URLS]
    return aggregate


def guess_sitemap_urls(home_url: str) -> list[str]:
    """Common sitemap locations plus whatever robots.txt advertises."""
    base = home_url if home_url.endswith("/") else home_url + "/"
    candidates = [
        urljoin(base, "sitemap.xml"),
        urljoin(base, "sitemap_index.xml"),
        urljoin(base, "sitemap-index.xml"),
        urljoin(base, "wp-sitemap.xml"),
        urljoin(base, "sitemap.xml.gz"),
    ]
    candidates.extend(read_robots_sitemaps(base))

    seen: set[str] = set()
    ordered = []
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)
    return ordered


def read_robots_sitemaps(home_url: str) -> list[str]:
    robots_url = urljoin(home_url, "/robots.txt")
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            response = client.get(robots_url, headers={"User-Agent": USER_AGENT})
            if response.status_code >= 400:
                return []
            text = response.text
    except httpx.HTTPError:
        return []

    found = []
    for line in text.splitlines():
        if line.lower().startswith("sitemap:"):
            value = line.split(":", 1)[1].strip()
            if value.startswith("http"):
                found.append(value)
    return found


def url_belongs_to_site(url: str, home_url: str, is_domain_property: bool) -> bool:
    target = urlparse(url)
    base = urlparse(home_url)
    if not target.netloc:
        return False
    if is_domain_property:
        root = base.netloc.removeprefix("www.")
        return target.netloc == root or target.netloc.endswith("." + root)
    return target.netloc == base.netloc
