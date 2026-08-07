"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSitemaps = listSitemaps;
exports.getSitemap = getSitemap;
exports.syncFromGsc = syncFromGsc;
exports.discoverSitemaps = discoverSitemaps;
exports.addSitemap = addSitemap;
exports.deleteSitemap = deleteSitemap;
exports.submitToGoogle = submitToGoogle;
exports.deleteFromGoogle = deleteFromGoogle;
exports.scanSitemap = scanSitemap;
exports.scanAllSitemaps = scanAllSitemaps;
const db_1 = require("../db");
const types_1 = require("../db/types");
const errors_1 = require("../google/errors");
const oauth_1 = require("../google/oauth");
const gsc = __importStar(require("../google/searchConsole"));
const crypto_1 = require("../lib/crypto");
const dates_1 = require("../lib/dates");
const activity_1 = require("./activity");
const sitemapParser = __importStar(require("./sitemapParser"));
const urls_1 = require("./urls");
const USER_AGENT = "IndexMeNow/1.0 (+sitemap-crawler)";
function toInt(value) {
    const parsed = Number.parseInt(String(value ?? 0), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}
function listSitemaps(siteId) {
    return db_1.db.selectFrom("sitemaps").selectAll().where("site_id", "=", siteId).orderBy("id").execute();
}
function getSitemap(sitemapId, siteId) {
    return db_1.db
        .selectFrom("sitemaps")
        .selectAll()
        .where("id", "=", sitemapId)
        .where("site_id", "=", siteId)
        .executeTakeFirst();
}
/** Odzwierciedla liste sitemap, ktore Google juz zna. */
async function syncFromGsc(userId, site) {
    const token = await (0, oauth_1.getAccessToken)(userId);
    const entries = await gsc.listSitemaps(token, site.property_url);
    let created = 0;
    let updated = 0;
    for (const entry of entries) {
        const path = entry.path;
        if (!path)
            continue;
        const hash = (0, crypto_1.sha256)(path);
        const values = {
            is_pending: Boolean(entry.isPending),
            is_sitemaps_index: Boolean(entry.isSitemapsIndex),
            warnings: toInt(entry.warnings),
            errors: toInt(entry.errors),
            url_count: (entry.contents ?? []).reduce((sum, c) => sum + toInt(c.submitted), 0),
            last_submitted_at: (0, dates_1.parseDate)(entry.lastSubmitted),
            last_downloaded_at: (0, dates_1.parseDate)(entry.lastDownloaded),
        };
        const existing = await db_1.db
            .selectFrom("sitemaps")
            .select("id")
            .where("site_id", "=", site.id)
            .where("path_hash", "=", hash)
            .executeTakeFirst();
        if (existing) {
            await db_1.db.updateTable("sitemaps").set(values).where("id", "=", existing.id).execute();
            updated += 1;
        }
        else {
            await db_1.db
                .insertInto("sitemaps")
                .values({ site_id: site.id, path, path_hash: hash, source: "gsc", ...values })
                .execute();
            created += 1;
        }
    }
    return { created, updated, total: entries.length };
}
/** Sprawdza typowe sciezki sitemap i to, co ogłasza robots.txt. */
async function discoverSitemaps(site) {
    const found = [];
    for (const candidate of await sitemapParser.guessSitemapUrls(site.home_url)) {
        try {
            // Czesc serwerow nie obsluguje HEAD - wtedy sprawdzamy przez GET.
            let response = await fetch(candidate, {
                method: "HEAD",
                headers: { "User-Agent": USER_AGENT },
                redirect: "follow",
                signal: AbortSignal.timeout(12_000),
            });
            if (!response.ok) {
                response = await fetch(candidate, {
                    headers: { "User-Agent": USER_AGENT },
                    redirect: "follow",
                    signal: AbortSignal.timeout(12_000),
                });
            }
            if (response.ok)
                found.push(candidate);
        }
        catch {
            continue;
        }
    }
    for (const path of found) {
        const hash = (0, crypto_1.sha256)(path);
        const existing = await db_1.db
            .selectFrom("sitemaps")
            .select("id")
            .where("site_id", "=", site.id)
            .where("path_hash", "=", hash)
            .executeTakeFirst();
        if (!existing) {
            await db_1.db
                .insertInto("sitemaps")
                .values({ site_id: site.id, path, path_hash: hash, source: "discovered" })
                .execute();
        }
    }
    return found;
}
async function addSitemap(site, path) {
    let clean = path.trim();
    if (!clean.startsWith("http")) {
        clean = `${site.home_url.replace(/\/+$/, "")}/${clean.replace(/^\/+/, "")}`;
    }
    const hash = (0, crypto_1.sha256)(clean);
    const existing = await db_1.db
        .selectFrom("sitemaps")
        .selectAll()
        .where("site_id", "=", site.id)
        .where("path_hash", "=", hash)
        .executeTakeFirst();
    if (existing)
        return existing;
    const inserted = await db_1.db
        .insertInto("sitemaps")
        .values({ site_id: site.id, path: clean, path_hash: hash, source: "manual" })
        .executeTakeFirst();
    return db_1.db
        .selectFrom("sitemaps")
        .selectAll()
        .where("id", "=", Number(inserted.insertId))
        .executeTakeFirstOrThrow();
}
async function deleteSitemap(sitemapId, siteId) {
    await db_1.db.deleteFrom("sitemaps").where("id", "=", sitemapId).where("site_id", "=", siteId).execute();
}
async function runSitemapJob(site, sitemap, jobType, action, successMessage, userId) {
    const inserted = await db_1.db
        .insertInto("index_jobs")
        .values({
        site_id: site.id,
        target: sitemap.path.slice(0, 2048),
        job_type: jobType,
        status: types_1.JobStatus.RUNNING,
    })
        .executeTakeFirst();
    const jobId = Number(inserted.insertId);
    let status = types_1.JobStatus.SUCCESS;
    let message = successMessage;
    try {
        const token = await (0, oauth_1.getAccessToken)(userId);
        await action(token);
        if (jobType === types_1.JobType.SITEMAP_SUBMIT) {
            await db_1.db
                .updateTable("sitemaps")
                .set({ last_submitted_at: new Date() })
                .where("id", "=", sitemap.id)
                .execute();
        }
    }
    catch (error) {
        status = types_1.JobStatus.FAILED;
        message = error instanceof errors_1.GoogleApiError ? error.toString() : String(error);
    }
    await db_1.db
        .updateTable("index_jobs")
        .set({ status, message, finished_at: new Date() })
        .where("id", "=", jobId)
        .execute();
    return { status, message };
}
function submitToGoogle(userId, site, sitemap) {
    return runSitemapJob(site, sitemap, types_1.JobType.SITEMAP_SUBMIT, (token) => gsc.submitSitemap(token, site.property_url, sitemap.path), "Sitemapa zgloszona do Google Search Console", userId);
}
function deleteFromGoogle(userId, site, sitemap) {
    return runSitemapJob(site, sitemap, types_1.JobType.SITEMAP_DELETE, (token) => gsc.deleteSitemap(token, site.property_url, sitemap.path), "Sitemapa usunieta z Google Search Console", userId);
}
/** Pobiera sitemape i importuje wszystkie zawarte w niej adresy. */
async function scanSitemap(site, sitemap) {
    const result = await sitemapParser.crawlSitemap(sitemap.path);
    if (result.error && result.entries.length === 0) {
        await db_1.db
            .updateTable("sitemaps")
            .set({ errors: (sitemap.errors ?? 0) + 1 })
            .where("id", "=", sitemap.id)
            .execute();
        return { added: 0, duplicates: 0, refreshed: 0, found: 0, error: result.error };
    }
    // Sitemapa moze wymieniac adresy z innych domen - Google odrzuci takie
    // zgloszenie, wiec odsiewamy je zanim trafia do bazy.
    const domainProperty = (0, types_1.isDomainProperty)(site);
    const valid = result.entries.filter((entry) => sitemapParser.urlBelongsToSite(entry.url, site.home_url, domainProperty));
    const lastmodMap = new Map();
    for (const entry of valid) {
        if (entry.lastmod)
            lastmodMap.set(entry.url, entry.lastmod);
    }
    const outcome = await (0, urls_1.addUrls)(site, valid.map((entry) => entry.url), "sitemap", lastmodMap);
    const now = new Date();
    await db_1.db
        .updateTable("sitemaps")
        .set({
        url_count: valid.length,
        last_downloaded_at: now,
        is_sitemaps_index: result.isIndex,
    })
        .where("id", "=", sitemap.id)
        .execute();
    await db_1.db.updateTable("sites").set({ last_scan_at: now }).where("id", "=", site.id).execute();
    return { ...outcome, found: result.entries.length, error: result.error ?? null };
}
async function scanAllSitemaps(site) {
    const totals = { added: 0, duplicates: 0, found: 0, sitemaps: 0, errors: [] };
    let sitemaps = await db_1.db
        .selectFrom("sitemaps")
        .selectAll()
        .where("site_id", "=", site.id)
        .where("auto_sync", "=", true)
        .execute();
    if (sitemaps.length === 0) {
        await discoverSitemaps(site);
        sitemaps = await listSitemaps(site.id);
    }
    for (const sitemap of sitemaps) {
        const outcome = await scanSitemap(site, sitemap);
        totals.added += outcome.added;
        totals.duplicates += outcome.duplicates;
        totals.found += outcome.found;
        totals.sitemaps += 1;
        if (outcome.error)
            totals.errors.push(`${sitemap.path}: ${outcome.error}`);
    }
    await (0, activity_1.logEvent)(`Skan sitemap dla ${site.display_name}: +${totals.added} nowych URL-i.`, {
        workspaceId: site.workspace_id,
        category: "sitemap",
        details: totals,
    });
    return totals;
}
//# sourceMappingURL=sitemaps.js.map