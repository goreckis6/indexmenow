import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
const USER_AGENT = "IndexMeNow/1.0 (+sitemap-crawler)";
const TIMEOUT_MS = 30_000;
const MAX_DEPTH = 3;
const MAX_URLS = 50_000;
function emptyResult(source) {
    return { source, entries: [], childSitemaps: [], isIndex: false, error: null };
}
function parseLastmod(value) {
    if (typeof value !== "string" || !value.trim())
        return null;
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.getTime()))
        return parsed;
    // Sitemapy czesto podaja sama date bez godziny.
    const dateOnly = new Date(value.trim().slice(0, 10));
    return Number.isNaN(dateOnly.getTime()) ? null : dateOnly;
}
export async function fetchBytes(url) {
    const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} przy pobieraniu ${url}`);
    }
    let content = Buffer.from(await response.arrayBuffer());
    // Rozpoznajemy gzip po naglowku pliku, a nie tylko po rozszerzeniu - czesc
    // serwerow oddaje spakowana sitemape pod adresem bez ".gz".
    if (url.endsWith(".gz") || (content[0] === 0x1f && content[1] === 0x8b)) {
        content = gunzipSync(content);
    }
    return content;
}
/** Zwraca zawsze tablice, niezaleznie od tego, czy XML mial jeden wpis czy wiele. */
function asArray(value) {
    if (value === undefined)
        return [];
    return Array.isArray(value) ? value : [value];
}
function textOf(value) {
    if (typeof value === "string")
        return value.trim();
    if (typeof value === "number")
        return String(value);
    if (typeof value === "object" && value !== null) {
        const inner = value["#text"];
        if (typeof inner === "string" || typeof inner === "number")
            return String(inner).trim();
    }
    return "";
}
export function parseSitemapXml(content, source) {
    const result = emptyResult(source);
    const text = content.toString("utf8");
    const parser = new XMLParser({
        ignoreAttributes: true,
        // Sitemapy uzywaja przestrzeni nazw (sitemap:url, image:image itd.).
        // Bez usuniecia prefiksow trafialyby pod klucze, ktorych nie sprawdzamy.
        removeNSPrefix: true,
        trimValues: true,
    });
    let parsed;
    try {
        parsed = parser.parse(text);
    }
    catch (error) {
        // Protokol dopuszcza sitemapy tekstowe - jeden adres na linie.
        const lines = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith("http"));
        if (lines.length > 0) {
            result.entries = lines.map((url) => ({ url }));
            return result;
        }
        result.error = `Nie udalo sie sparsowac XML: ${error instanceof Error ? error.message : error}`;
        return result;
    }
    const index = parsed["sitemapindex"];
    if (index && typeof index === "object") {
        result.isIndex = true;
        for (const item of asArray(index["sitemap"])) {
            const loc = textOf(item?.["loc"]);
            if (loc)
                result.childSitemaps.push(loc);
        }
        return result;
    }
    const urlset = parsed["urlset"];
    if (urlset && typeof urlset === "object") {
        for (const item of asArray(urlset["url"])) {
            const record = item;
            const loc = textOf(record?.["loc"]);
            if (!loc)
                continue;
            const priorityText = textOf(record["priority"]);
            const priority = priorityText ? Number.parseFloat(priorityText) : null;
            result.entries.push({
                url: loc,
                lastmod: parseLastmod(textOf(record["lastmod"])),
                priority: priority !== null && Number.isFinite(priority) ? priority : null,
            });
        }
        return result;
    }
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("http"));
    if (lines.length > 0) {
        result.entries = lines.map((url) => ({ url }));
        return result;
    }
    result.error = "Plik nie wyglada na sitemape (brak <urlset> i <sitemapindex>).";
    return result;
}
/** Pobiera sitemape i rozwija rekurencyjnie pliki indeksu. */
export async function crawlSitemap(url, depth = 0, seen = new Set()) {
    const aggregate = emptyResult(url);
    if (seen.has(url) || depth > MAX_DEPTH)
        return aggregate;
    seen.add(url);
    let content;
    try {
        content = await fetchBytes(url);
    }
    catch (error) {
        aggregate.error = error instanceof Error ? error.message : String(error);
        return aggregate;
    }
    const parsed = parseSitemapXml(content, url);
    aggregate.error = parsed.error ?? null;
    aggregate.isIndex = parsed.isIndex;
    aggregate.entries.push(...parsed.entries);
    aggregate.childSitemaps.push(...parsed.childSitemaps);
    for (const childUrl of parsed.childSitemaps) {
        if (aggregate.entries.length >= MAX_URLS)
            break;
        const child = await crawlSitemap(childUrl, depth + 1, seen);
        aggregate.entries.push(...child.entries);
    }
    const unique = new Map();
    for (const entry of aggregate.entries) {
        if (!unique.has(entry.url))
            unique.set(entry.url, entry);
    }
    aggregate.entries = [...unique.values()].slice(0, MAX_URLS);
    return aggregate;
}
export async function readRobotsSitemaps(homeUrl) {
    let robotsUrl;
    try {
        robotsUrl = new URL("/robots.txt", homeUrl).toString();
    }
    catch {
        return [];
    }
    try {
        const response = await fetch(robotsUrl, {
            headers: { "User-Agent": USER_AGENT },
            redirect: "follow",
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok)
            return [];
        const text = await response.text();
        return text
            .split(/\r?\n/)
            .filter((line) => line.toLowerCase().startsWith("sitemap:"))
            .map((line) => line.slice(line.indexOf(":") + 1).trim())
            .filter((value) => value.startsWith("http"));
    }
    catch {
        return [];
    }
}
/** Typowe lokalizacje sitemap plus to, co ogłasza robots.txt. */
export async function guessSitemapUrls(homeUrl) {
    const base = homeUrl.endsWith("/") ? homeUrl : `${homeUrl}/`;
    const candidates = [
        "sitemap.xml",
        "sitemap_index.xml",
        "sitemap-index.xml",
        "wp-sitemap.xml",
        "sitemap.xml.gz",
    ].map((name) => new URL(name, base).toString());
    candidates.push(...(await readRobotsSitemaps(base)));
    return [...new Set(candidates)];
}
export function urlBelongsToSite(url, homeUrl, isDomainProperty) {
    let target;
    let base;
    try {
        target = new URL(url);
        base = new URL(homeUrl);
    }
    catch {
        return false;
    }
    if (!target.host)
        return false;
    if (isDomainProperty) {
        // Wlasciwosc domenowa obejmuje wszystkie subdomeny.
        const root = base.host.replace(/^www\./, "");
        return target.host === root || target.host.endsWith(`.${root}`);
    }
    return target.host === base.host;
}
//# sourceMappingURL=sitemapParser.js.map