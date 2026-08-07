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
exports.apiRouter = void 0;
const express_1 = require("express");
const kysely_1 = require("kysely");
const db_1 = require("../db");
const types_1 = require("../db/types");
const auth_1 = require("../middleware/auth");
const quota = __importStar(require("../services/quota"));
const scheduler_1 = require("../services/scheduler");
const urls_1 = require("../services/urls");
const stats_1 = require("../services/stats");
exports.apiRouter = (0, express_1.Router)();
exports.apiRouter.use(auth_1.loadUser, auth_1.requireApiAuth, auth_1.resolveWorkspace);
exports.apiRouter.get("/overview", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const used = await quota.getUsage(workspace.id);
    const siteCount = await db_1.db
        .selectFrom("sites")
        .select((eb) => eb.fn.countAll().as("total"))
        .where("workspace_id", "=", workspace.id)
        .executeTakeFirst();
    res.json({
        workspace: { id: workspace.id, name: workspace.name },
        urls: await (0, urls_1.workspaceUrlStats)(workspace.id),
        quota: {
            used,
            limit: workspace.daily_quota,
            remaining: Math.max(0, workspace.daily_quota - used),
        },
        sites: Number(siteCount?.total ?? 0),
        history: await (0, stats_1.workspaceIndexingHistory)(workspace.id, 30),
        submissions: await quota.submissionsLastDays(workspace.id, 30),
    });
}));
exports.apiRouter.get("/tasks", (0, auth_1.asyncHandler)(async (req, res) => {
    const running = (0, scheduler_1.runningTasks)();
    const recent = await db_1.db
        .selectFrom("index_jobs")
        .innerJoin("sites", "sites.id", "index_jobs.site_id")
        .selectAll("index_jobs")
        .where("sites.workspace_id", "=", req.workspace.id)
        .orderBy("index_jobs.created_at", "desc")
        .limit(8)
        .execute();
    res.json({
        running,
        busy: running.length > 0,
        next_runs: (0, scheduler_1.nextRunTimes)(),
        recent: recent.map((job) => ({
            id: job.id,
            target: job.target,
            type: job.job_type,
            status: job.status,
            message: job.message,
            created_at: job.created_at?.toISOString() ?? null,
        })),
    });
}));
exports.apiRouter.get("/sites/:siteId/summary", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    res.json({
        id: site.id,
        name: site.display_name,
        property: site.property_url,
        auto_index: site.auto_index,
        stats: await (0, urls_1.siteUrlStats)(site.id),
        last_scan_at: site.last_scan_at?.toISOString() ?? null,
        last_index_run_at: site.last_index_run_at?.toISOString() ?? null,
        busy: (0, scheduler_1.runningTasks)().includes(`site:${site.id}`),
    });
}));
exports.apiRouter.get("/urls/:urlId", (0, auth_1.asyncHandler)(async (req, res) => {
    const page = await db_1.db
        .selectFrom("urls")
        .innerJoin("sites", "sites.id", "urls.site_id")
        .selectAll("urls")
        .where("urls.id", "=", Number(req.params.urlId))
        .where("sites.workspace_id", "=", req.workspace.id)
        .executeTakeFirst();
    if (!page)
        return res.status(404).json({ detail: "Nie znaleziono" });
    const jobs = await db_1.db
        .selectFrom("index_jobs")
        .selectAll()
        .where("url_id", "=", page.id)
        .orderBy("created_at", "desc")
        .limit(10)
        .execute();
    res.json({
        id: page.id,
        url: page.url,
        status: page.index_status,
        coverage_state: page.coverage_state,
        verdict: page.verdict,
        robots_state: page.robots_state,
        page_fetch_state: page.page_fetch_state,
        canonical_google: page.canonical_google,
        canonical_user: page.canonical_user,
        last_crawl_at: page.last_crawl_at?.toISOString() ?? null,
        last_checked_at: page.last_checked_at?.toISOString() ?? null,
        last_submitted_at: page.last_submitted_at?.toISOString() ?? null,
        submit_count: page.submit_count,
        error: page.error_message,
        jobs: jobs.map((job) => ({
            type: job.job_type,
            status: job.status,
            message: job.message,
            created_at: job.created_at?.toISOString() ?? null,
        })),
    });
}));
exports.apiRouter.get("/status-breakdown", (0, auth_1.asyncHandler)(async (req, res) => {
    const rows = await db_1.db
        .selectFrom("urls")
        .innerJoin("sites", "sites.id", "urls.site_id")
        .select(["urls.index_status as status", (0, kysely_1.sql) `COUNT(urls.id)`.as("total")])
        .where("sites.workspace_id", "=", req.workspace.id)
        .groupBy("urls.index_status")
        .execute();
    const counts = Object.fromEntries(Object.values(types_1.IndexStatus).map((s) => [s, 0]));
    for (const row of rows)
        counts[row.status] = Number(row.total);
    res.json(counts);
}));
//# sourceMappingURL=api.js.map