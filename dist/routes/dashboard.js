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
exports.dashboardRouter = void 0;
const express_1 = require("express");
const kysely_1 = require("kysely");
const types_1 = require("../db/types");
const db_1 = require("../db");
const auth_1 = require("../middleware/auth");
const quota = __importStar(require("../services/quota"));
const scheduler_1 = require("../services/scheduler");
const stats_1 = require("../services/stats");
const urls_1 = require("../services/urls");
const workspaces_1 = require("../services/workspaces");
const templating_1 = require("../templating");
const auth_2 = require("./auth");
exports.dashboardRouter = (0, express_1.Router)();
exports.dashboardRouter.use(...auth_2.panelAuth);
exports.dashboardRouter.get("/", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const user = req.user;
    const sites = await db_1.db
        .selectFrom("sites")
        .selectAll()
        .where("workspace_id", "=", workspace.id)
        .orderBy("priority", "desc")
        .orderBy("display_name")
        .execute();
    const countRows = await db_1.db
        .selectFrom("urls")
        .innerJoin("sites", "sites.id", "urls.site_id")
        .select(["urls.site_id as site_id", (0, kysely_1.sql) `COUNT(urls.id)`.as("total")])
        .where("sites.workspace_id", "=", workspace.id)
        .where("urls.is_active", "=", true)
        .groupBy("urls.site_id")
        .execute();
    const indexedRows = await db_1.db
        .selectFrom("urls")
        .innerJoin("sites", "sites.id", "urls.site_id")
        .select(["urls.site_id as site_id", (0, kysely_1.sql) `COUNT(urls.id)`.as("total")])
        .where("sites.workspace_id", "=", workspace.id)
        .where("urls.is_active", "=", true)
        .where("urls.index_status", "=", "INDEXED")
        .groupBy("urls.site_id")
        .execute();
    const perSiteCounts = new Map(countRows.map((r) => [r.site_id, Number(r.total)]));
    const perSiteIndexed = new Map(indexedRows.map((r) => [r.site_id, Number(r.total)]));
    const siteRows = sites.map((site) => {
        const total = perSiteCounts.get(site.id) ?? 0;
        const indexed = perSiteIndexed.get(site.id) ?? 0;
        return {
            site,
            total,
            indexed,
            coverage: total ? Math.round((indexed / total) * 100) : 0,
        };
    });
    const usedToday = await quota.getUsage(workspace.id, types_1.Engine.GOOGLE);
    const stats = await (0, urls_1.workspaceUrlStats)(workspace.id);
    res.render("dashboard.html", (0, templating_1.baseContext)(req, {
        user,
        workspace,
        workspaces: await (0, workspaces_1.listWorkspaces)(user.id),
        stats,
        site_rows: siteRows,
        quota_used: usedToday,
        quota_limit: workspace.daily_quota,
        quota_percent: workspace.daily_quota
            ? Math.round((usedToday / workspace.daily_quota) * 100)
            : 0,
        history: await (0, stats_1.workspaceIndexingHistory)(workspace.id, 30),
        submissions: await quota.submissionsLastDays(workspace.id, 30),
        jobs: await (0, stats_1.recentJobs)(workspace.id, 12),
        job_totals: await (0, stats_1.jobTotals)(workspace.id, 30),
        next_runs: (0, scheduler_1.nextRunTimes)(),
        running: (0, scheduler_1.runningTasks)(),
        active_page: "dashboard",
    }));
}));
//# sourceMappingURL=dashboard.js.map