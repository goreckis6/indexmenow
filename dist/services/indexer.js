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
exports.resolveIndexingToken = resolveIndexingToken;
exports.mapIndexStatus = mapIndexStatus;
exports.inspectSingle = inspectSingle;
exports.inspectBatch = inspectBatch;
exports.submitSingle = submitSingle;
exports.submitBatch = submitBatch;
exports.submitIndexNow = submitIndexNow;
exports.runSitePipeline = runSitePipeline;
const config_1 = require("../config");
const db_1 = require("../db");
const types_1 = require("../db/types");
const errors_1 = require("../google/errors");
const indexing = __importStar(require("../google/indexing"));
const indexnow = __importStar(require("../google/indexnow"));
const oauth_1 = require("../google/oauth");
const gsc = __importStar(require("../google/searchConsole"));
const serviceAccount_1 = require("../google/serviceAccount");
const crypto_1 = require("../lib/crypto");
const activity_1 = require("./activity");
const quota = __importStar(require("./quota"));
const sitemaps_1 = require("./sitemaps");
const stats_1 = require("./stats");
const urls_1 = require("./urls");
const EXCLUSION_MARKERS = [
    "excluded",
    "duplicate",
    "alternate page",
    "noindex",
    "redirect",
    "not found",
    "soft 404",
    "blocked",
    "canonical",
];
const NOT_INDEXED_MARKERS = ["not indexed", "unknown to google", "discovered", "crawled -"];
function sleep(seconds) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
/**
 * Konto serwisowe ma wlasny limit zgloszen, wiec ma pierwszenstwo przed
 * tokenem OAuth uzytkownika - dzieki temu limit konta Google zostaje wolny
 * na inspekcje URL-i.
 */
async function resolveIndexingToken(userId, userEmail, workspace) {
    const account = await db_1.db
        .selectFrom("service_accounts")
        .selectAll()
        .where("workspace_id", "=", workspace.id)
        .where("is_active", "=", true)
        // Najdawniej uzywane konto idzie pierwsze, zeby rozlozyc obciazenie.
        .orderBy("last_used_at", "asc")
        .executeTakeFirst();
    if (account) {
        const privateKey = (0, crypto_1.decrypt)(account.private_key_enc);
        if (privateKey) {
            const info = (0, serviceAccount_1.credentialsInfo)(account.client_email, privateKey, account.project_id);
            const token = await (0, serviceAccount_1.getServiceAccountToken)(info);
            await db_1.db
                .updateTable("service_accounts")
                .set({ last_used_at: new Date() })
                .where("id", "=", account.id)
                .execute();
            return { token, label: `service-account:${account.client_email}` };
        }
    }
    return { token: await (0, oauth_1.getAccessToken)(userId), label: `oauth:${userEmail}` };
}
function mapIndexStatus(verdict, coverageState) {
    const coverage = (coverageState ?? "").toLowerCase();
    if (verdict === "PASS")
        return types_1.IndexStatus.INDEXED;
    if (NOT_INDEXED_MARKERS.some((marker) => coverage.includes(marker))) {
        return types_1.IndexStatus.NOT_INDEXED;
    }
    if (EXCLUSION_MARKERS.some((marker) => coverage.includes(marker)))
        return types_1.IndexStatus.EXCLUDED;
    if (verdict === "FAIL" || verdict === "NEUTRAL" || verdict === "PARTIAL") {
        return types_1.IndexStatus.NOT_INDEXED;
    }
    return types_1.IndexStatus.UNKNOWN;
}
function trim(value, length) {
    if (!value)
        return null;
    return value.slice(0, length) || null;
}
async function inspectSingle(userId, site, page, triggeredBy = "manual") {
    const inserted = await db_1.db
        .insertInto("index_jobs")
        .values({
        site_id: site.id,
        url_id: page.id,
        target: page.url.slice(0, 2048),
        job_type: types_1.JobType.INSPECT,
        engine: types_1.Engine.GOOGLE,
        status: types_1.JobStatus.RUNNING,
        triggered_by: triggeredBy,
    })
        .executeTakeFirst();
    const jobId = Number(inserted.insertId);
    const started = process.hrtime.bigint();
    let jobStatus = types_1.JobStatus.SUCCESS;
    let message = "";
    let indexStatus = page.index_status;
    let payload = null;
    try {
        const token = await (0, oauth_1.getAccessToken)(userId);
        const result = await gsc.inspectUrl(token, site.property_url, page.url);
        const statusResult = result.inspectionResult?.indexStatusResult ?? {};
        indexStatus = mapIndexStatus(statusResult.verdict, statusResult.coverageState);
        const lastCrawl = statusResult.lastCrawlTime ? new Date(statusResult.lastCrawlTime) : null;
        await db_1.db
            .updateTable("urls")
            .set({
            index_status: indexStatus,
            verdict: trim(statusResult.verdict, 32),
            coverage_state: trim(statusResult.coverageState, 255),
            robots_state: trim(statusResult.robotsTxtState, 64),
            page_fetch_state: trim(statusResult.pageFetchState, 64),
            canonical_google: trim(statusResult.googleCanonical, 2048),
            canonical_user: trim(statusResult.userCanonical, 2048),
            last_checked_at: new Date(),
            last_crawl_at: lastCrawl && !Number.isNaN(lastCrawl.getTime()) ? lastCrawl : null,
            error_message: null,
        })
            .where("id", "=", page.id)
            .execute();
        message = statusResult.coverageState ?? indexStatus;
        payload = statusResult;
    }
    catch (error) {
        const reason = error instanceof errors_1.GoogleApiError ? error.toString() : String(error);
        jobStatus = types_1.JobStatus.FAILED;
        message = reason;
        // Nieudana inspekcja tez liczy sie jako sprawdzenie - inaczej ten sam
        // adres blokowalby kolejke przy kazdym przebiegu.
        await db_1.db
            .updateTable("urls")
            .set({
            last_checked_at: new Date(),
            error_message: reason.slice(0, 500),
            ...(page.index_status === types_1.IndexStatus.UNKNOWN
                ? { index_status: types_1.IndexStatus.ERROR }
                : {}),
        })
            .where("id", "=", page.id)
            .execute();
        if (page.index_status === types_1.IndexStatus.UNKNOWN)
            indexStatus = types_1.IndexStatus.ERROR;
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    await db_1.db
        .updateTable("index_jobs")
        .set({
        status: jobStatus,
        message: message.slice(0, 2000),
        payload: payload === null ? null : JSON.stringify(payload),
        duration_ms: Math.round(durationMs * 10) / 10,
        finished_at: new Date(),
    })
        .where("id", "=", jobId)
        .execute();
    return { status: jobStatus, indexStatus, message };
}
async function inspectBatch(userId, site, limit = config_1.config.inspectionBatchSize, triggeredBy = "manual") {
    const pages = await (0, urls_1.pickUrlsForInspection)(site.id, limit, config_1.config.recheckAfterDays);
    const summary = {
        checked: 0,
        indexed: 0,
        not_indexed: 0,
        excluded: 0,
        errors: 0,
    };
    for (const page of pages) {
        const outcome = await inspectSingle(userId, site, page, triggeredBy);
        summary.checked += 1;
        if (outcome.status === types_1.JobStatus.FAILED) {
            summary.errors += 1;
            // Po wyczerpaniu limitu dalsze proby tylko generuja bledy.
            if (outcome.message.toLowerCase().includes("quota"))
                break;
        }
        else if (outcome.indexStatus === types_1.IndexStatus.INDEXED) {
            summary.indexed += 1;
        }
        else if (outcome.indexStatus === types_1.IndexStatus.EXCLUDED) {
            summary.excluded += 1;
        }
        else {
            summary.not_indexed += 1;
        }
        await sleep(config_1.config.apiThrottleSeconds);
    }
    await (0, stats_1.recordSiteSnapshot)(site, 0, summary.checked);
    return summary;
}
async function submitSingle(ctx, site, page, target, jobType = types_1.JobType.URL_UPDATED, triggeredBy = "manual") {
    const { workspace } = ctx;
    const inserted = await db_1.db
        .insertInto("index_jobs")
        .values({
        site_id: site.id,
        url_id: page?.id ?? null,
        target: target.slice(0, 2048),
        job_type: jobType,
        engine: types_1.Engine.GOOGLE,
        status: types_1.JobStatus.RUNNING,
        triggered_by: triggeredBy,
    })
        .executeTakeFirst();
    const jobId = Number(inserted.insertId);
    const started = process.hrtime.bigint();
    let status;
    let message;
    let payload = null;
    let credentialLabel = ctx.resolved?.label ?? "";
    if ((await quota.remaining(workspace)) <= 0) {
        status = types_1.JobStatus.SKIPPED;
        message = "Wyczerpany dzienny limit zgloszen do Google Indexing API.";
    }
    else {
        try {
            const credential = ctx.resolved ?? (await resolveIndexingToken(ctx.userId, ctx.userEmail, workspace));
            credentialLabel = credential.label;
            const response = await indexing.publishUrl(credential.token, target, jobType === types_1.JobType.URL_DELETED ? "URL_DELETED" : "URL_UPDATED");
            await quota.consume(workspace.id, 1, types_1.Engine.GOOGLE);
            status = types_1.JobStatus.SUCCESS;
            message = "Zgloszono do Google Indexing API";
            payload = { response, credential: credential.label };
            if (page) {
                await db_1.db
                    .updateTable("urls")
                    .set({
                    last_submitted_at: new Date(),
                    submit_count: (page.submit_count ?? 0) + 1,
                })
                    .where("id", "=", page.id)
                    .execute();
            }
        }
        catch (error) {
            status = types_1.JobStatus.FAILED;
            message = error instanceof errors_1.GoogleApiError ? error.toString() : String(error);
            payload = {
                credential: credentialLabel,
                error: error instanceof errors_1.GoogleApiError ? error.payload : String(error),
            };
        }
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    await db_1.db
        .updateTable("index_jobs")
        .set({
        status,
        message: message.slice(0, 2000),
        payload: payload === null ? null : JSON.stringify(payload),
        duration_ms: Math.round(durationMs * 10) / 10,
        finished_at: new Date(),
    })
        .where("id", "=", jobId)
        .execute();
    return { status, message };
}
async function submitBatch(userId, userEmail, workspace, site, pages, jobType = types_1.JobType.URL_UPDATED, triggeredBy = "manual") {
    const summary = { submitted: 0, failed: 0, skipped: 0, messages: [] };
    if (pages.length === 0)
        return summary;
    let resolved;
    try {
        // Token pobierany raz na cala partie - inaczej kazdy adres oznaczalby
        // dodatkowe zapytanie o token.
        resolved = await resolveIndexingToken(userId, userEmail, workspace);
    }
    catch (error) {
        summary.failed = pages.length;
        summary.messages.push(error instanceof errors_1.GoogleApiError ? error.toString() : String(error));
        return summary;
    }
    const ctx = { userId, userEmail, workspace, resolved };
    for (const page of pages) {
        const outcome = await submitSingle(ctx, site, page, page.url, jobType, triggeredBy);
        if (outcome.status === types_1.JobStatus.SUCCESS) {
            summary.submitted += 1;
        }
        else if (outcome.status === types_1.JobStatus.SKIPPED) {
            summary.skipped += 1;
            summary.messages.push(outcome.message);
            break;
        }
        else {
            summary.failed += 1;
            if (outcome.message)
                summary.messages.push(outcome.message);
            const lower = outcome.message.toLowerCase();
            if (lower.includes("quota") || outcome.message.includes("429"))
                break;
        }
        await sleep(config_1.config.apiThrottleSeconds);
    }
    await db_1.db
        .updateTable("sites")
        .set({ last_index_run_at: new Date() })
        .where("id", "=", site.id)
        .execute();
    await (0, stats_1.recordSiteSnapshot)(site, summary.submitted, 0);
    return summary;
}
async function submitIndexNow(site, urls) {
    if (!site.indexnow_key) {
        return { ok: false, status: 0, message: "Brak klucza IndexNow dla tej strony.", count: 0 };
    }
    if (urls.length === 0) {
        return { ok: false, status: 0, message: "Brak URL-i do zgloszenia.", count: 0 };
    }
    const keyLocation = indexnow.keyFileUrl(site.home_url, site.indexnow_key);
    const inserted = await db_1.db
        .insertInto("index_jobs")
        .values({
        site_id: site.id,
        target: `${urls.length} URL-i`,
        job_type: types_1.JobType.INDEXNOW,
        engine: types_1.Engine.BING,
        status: types_1.JobStatus.RUNNING,
    })
        .executeTakeFirst();
    const jobId = Number(inserted.insertId);
    let result;
    try {
        result = await indexnow.submitUrls(urls, site.indexnow_key, keyLocation);
    }
    catch (error) {
        result = {
            ok: false,
            status: 0,
            message: error instanceof errors_1.GoogleApiError ? error.toString() : String(error),
            count: urls.length,
        };
    }
    await db_1.db
        .updateTable("index_jobs")
        .set({
        status: result.ok ? types_1.JobStatus.SUCCESS : types_1.JobStatus.FAILED,
        message: `${result.message} (${result.count} URL-i)`,
        payload: JSON.stringify(result),
        finished_at: new Date(),
    })
        .where("id", "=", jobId)
        .execute();
    return result;
}
/** Pelny cykl dla jednej strony: odswiez URL-e, sprawdz, zglos brakujace. */
async function runSitePipeline(userId, userEmail, workspace, site, triggeredBy = "auto", scanSitemaps = true) {
    const report = { site: site.display_name };
    if (scanSitemaps) {
        try {
            report.scan = await (0, sitemaps_1.scanAllSitemaps)(site);
        }
        catch (error) {
            // Blad skanu nie moze zatrzymac indeksowania tego, co juz jest w bazie.
            report.scan = { error: error instanceof Error ? error.message : String(error) };
            console.error(`Skan sitemap nie udal sie dla ${site.display_name}`, error);
        }
    }
    try {
        report.inspection = await inspectBatch(userId, site, config_1.config.inspectionBatchSize, triggeredBy);
    }
    catch (error) {
        report.inspection = { error: error instanceof Error ? error.message : String(error) };
    }
    const budget = Math.min(site.daily_limit, await quota.remaining(workspace));
    if (budget <= 0) {
        report.submission = { skipped: true, reason: "Brak dostepnego limitu na dzis." };
        return report;
    }
    const pages = await (0, urls_1.pickUrlsForSubmission)(site.id, budget);
    const submission = await submitBatch(userId, userEmail, workspace, site, pages, types_1.JobType.URL_UPDATED, triggeredBy);
    report.submission = submission;
    if (site.indexnow_enabled && pages.length > 0) {
        report.indexnow = await submitIndexNow(site, pages.map((p) => p.url));
    }
    await (0, activity_1.logEvent)(`Auto-indeksowanie ${site.display_name}: zgloszono ${submission.submitted} URL-i.`, { workspaceId: workspace.id, category: "indexing", details: report });
    return report;
}
//# sourceMappingURL=indexer.js.map