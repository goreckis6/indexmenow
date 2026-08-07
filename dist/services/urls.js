"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeUrl = normalizeUrl;
exports.parseUrlBlob = parseUrlBlob;
exports.addUrls = addUrls;
exports.siteUrlStats = siteUrlStats;
exports.workspaceUrlStats = workspaceUrlStats;
exports.pickUrlsForInspection = pickUrlsForInspection;
exports.pickUrlsForSubmission = pickUrlsForSubmission;
exports.listUrls = listUrls;
const kysely_1 = require("kysely");
const db_1 = require("../db");
const types_1 = require("../db/types");
const crypto_1 = require("../lib/crypto");
const dates_1 = require("../lib/dates");
const TRACKING_PARAMS = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
    "msclkid",
]);
function normalizeUrl(raw) {
    let value = (raw ?? "").trim();
    if (!value || value.startsWith("#"))
        return null;
    if (!/^https?:\/\//i.test(value))
        value = `https://${value.replace(/^\/+/, "")}`;
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return null;
    }
    // Host bez kropki to prawie zawsze literowka we wklejonej liscie, a nie
    // adres. Bez tej kontroli "nie-adres" trafialoby do bazy jako
    // https://nie-adres/ i marnowalo dzienny limit zgloszen.
    if (!parsed.hostname.includes(".") || parsed.hostname.startsWith(".") || parsed.hostname.endsWith("."))
        return null;
    // Parametry sledzace nie tworza nowej strony, a rozbijalyby ten sam adres
    // na kilka wpisow i marnowaly dzienny limit zgloszen.
    for (const param of [...parsed.searchParams.keys()]) {
        if (TRACKING_PARAMS.has(param.toLowerCase()))
            parsed.searchParams.delete(param);
    }
    parsed.hash = "";
    return parsed.toString();
}
/** Przyjmuje adresy rozdzielone nowa linia, przecinkiem albo spacja. */
function parseUrlBlob(blob) {
    const unique = [];
    const seen = new Set();
    for (const token of (blob ?? "").split(/[\s,]+/)) {
        const normalized = normalizeUrl(token);
        if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            unique.push(normalized);
        }
    }
    return unique;
}
async function addUrls(site, urls, source = "manual", lastmodMap = new Map(), priority = 0) {
    const result = { added: 0, duplicates: 0, refreshed: 0, total: urls.length };
    if (urls.length === 0)
        return result;
    const existingRows = await db_1.db
        .selectFrom("urls")
        .select(["url", "url_hash", "lastmod"])
        .where("site_id", "=", site.id)
        .execute();
    const existing = new Map(existingRows.map((row) => [row.url_hash, row]));
    const toInsert = [];
    for (const url of urls) {
        const hash = (0, crypto_1.sha256)(url);
        const found = existing.get(hash);
        if (found) {
            result.duplicates += 1;
            const lastmod = lastmodMap.get(url);
            if (lastmod && found.lastmod?.getTime() !== lastmod.getTime()) {
                await db_1.db
                    .updateTable("urls")
                    .set({ lastmod })
                    .where("site_id", "=", site.id)
                    .where("url_hash", "=", hash)
                    .execute();
                result.refreshed += 1;
            }
            continue;
        }
        toInsert.push({
            site_id: site.id,
            url: url.slice(0, 2048),
            url_hash: hash,
            source,
            priority,
            lastmod: lastmodMap.get(url) ?? null,
        });
        existing.set(hash, { url, url_hash: hash, lastmod: null });
        result.added += 1;
    }
    // Sitemapa moze miec dziesiatki tysiecy adresow, a MySQL ma limit rozmiaru
    // pojedynczego zapytania - stad porcje po 500.
    for (let i = 0; i < toInsert.length; i += 500) {
        await db_1.db.insertInto("urls").values(toInsert.slice(i, i + 500)).execute();
    }
    return result;
}
function emptyCounts() {
    return Object.fromEntries(Object.values(types_1.IndexStatus).map((status) => [status, 0]));
}
function summarize(rows) {
    const counts = emptyCounts();
    for (const row of rows)
        counts[row.index_status] = Number(row.total);
    const total = Object.values(types_1.IndexStatus).reduce((sum, status) => sum + (counts[status] ?? 0), 0);
    // Adresy o nieznanym statusie nie wchodza do pokrycia - inaczej swiezo dodana
    // strona pokazywalaby 0% mimo tego, ze nic jeszcze nie sprawdzono.
    const known = total - (counts[types_1.IndexStatus.UNKNOWN] ?? 0);
    const coverage = known ? Math.round(((counts[types_1.IndexStatus.INDEXED] ?? 0) / known) * 1000) / 10 : 0;
    return { ...counts, total, coverage };
}
async function siteUrlStats(siteId) {
    const rows = await db_1.db
        .selectFrom("urls")
        .select(["index_status", (0, kysely_1.sql) `COUNT(id)`.as("total")])
        .where("site_id", "=", siteId)
        .where("is_active", "=", true)
        .groupBy("index_status")
        .execute();
    return summarize(rows);
}
async function workspaceUrlStats(workspaceId) {
    const rows = await db_1.db
        .selectFrom("urls")
        .innerJoin("sites", "sites.id", "urls.site_id")
        .select(["urls.index_status as index_status", (0, kysely_1.sql) `COUNT(urls.id)`.as("total")])
        .where("sites.workspace_id", "=", workspaceId)
        .where("urls.is_active", "=", true)
        .groupBy("urls.index_status")
        .execute();
    return summarize(rows);
}
/** Najpierw nigdy nie sprawdzane, potem najbardziej przedawnione. */
async function pickUrlsForInspection(siteId, limit, recheckDays) {
    const neverChecked = await db_1.db
        .selectFrom("urls")
        .selectAll()
        .where("site_id", "=", siteId)
        .where("is_active", "=", true)
        .where("last_checked_at", "is", null)
        .orderBy("priority", "desc")
        .orderBy("id")
        .limit(limit)
        .execute();
    if (neverChecked.length >= limit)
        return neverChecked;
    const stale = await db_1.db
        .selectFrom("urls")
        .selectAll()
        .where("site_id", "=", siteId)
        .where("is_active", "=", true)
        .where("last_checked_at", "is not", null)
        .where("last_checked_at", "<", (0, dates_1.daysAgo)(recheckDays))
        .where("index_status", "!=", types_1.IndexStatus.INDEXED)
        .orderBy("last_checked_at")
        .limit(limit - neverChecked.length)
        .execute();
    return [...neverChecked, ...stale];
}
/** Najpierw potwierdzone niezaindeksowane, potem o nieznanym statusie. */
async function pickUrlsForSubmission(siteId, limit) {
    const notIndexed = await db_1.db
        .selectFrom("urls")
        .selectAll()
        .where("site_id", "=", siteId)
        .where("is_active", "=", true)
        .where("index_status", "in", [types_1.IndexStatus.NOT_INDEXED, types_1.IndexStatus.ERROR])
        .orderBy("priority", "desc")
        // Adresy nigdy nie zglaszane maja pierwszenstwo przed tymi, ktore juz raz poszly.
        .orderBy((0, kysely_1.sql) `last_submitted_at IS NOT NULL`)
        .orderBy("last_submitted_at")
        .orderBy("id")
        .limit(limit)
        .execute();
    if (notIndexed.length >= limit)
        return notIndexed;
    const unknown = await db_1.db
        .selectFrom("urls")
        .selectAll()
        .where("site_id", "=", siteId)
        .where("is_active", "=", true)
        .where("index_status", "=", types_1.IndexStatus.UNKNOWN)
        .where("last_submitted_at", "is", null)
        .orderBy("priority", "desc")
        .orderBy("id")
        .limit(limit - notIndexed.length)
        .execute();
    return [...notIndexed, ...unknown];
}
async function listUrls(options) {
    const { workspaceId, siteId, status, search, page = 1, perPage = 50 } = options;
    let query = db_1.db
        .selectFrom("urls")
        .innerJoin("sites", "sites.id", "urls.site_id")
        .where("sites.workspace_id", "=", workspaceId);
    if (siteId)
        query = query.where("urls.site_id", "=", siteId);
    if (status && status !== "ALL")
        query = query.where("urls.index_status", "=", status);
    if (search)
        query = query.where("urls.url", "like", `%${search}%`);
    const totalRow = await query
        .select((0, kysely_1.sql) `COUNT(urls.id)`.as("total"))
        .executeTakeFirst();
    const total = Number(totalRow?.total ?? 0);
    const rows = await query
        .selectAll("urls")
        .select(["sites.display_name as site_name", "sites.property_url as site_property"])
        .orderBy("urls.last_checked_at", "desc")
        .orderBy("urls.id", "desc")
        .limit(perPage)
        .offset((page - 1) * perPage)
        .execute();
    return { rows, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}
//# sourceMappingURL=urls.js.map