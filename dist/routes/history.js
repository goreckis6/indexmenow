"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.historyRouter = void 0;
const express_1 = require("express");
const kysely_1 = require("kysely");
const db_1 = require("../db");
const types_1 = require("../db/types");
const auth_1 = require("../middleware/auth");
const sites_1 = require("../services/sites");
const stats_1 = require("../services/stats");
const templating_1 = require("../templating");
const auth_2 = require("./auth");
exports.historyRouter = (0, express_1.Router)();
exports.historyRouter.use(...auth_2.panelAuth);
const PER_PAGE = 60;
exports.historyRouter.get("/", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const siteId = Number(req.query.site_id) || 0;
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const jobType = typeof req.query.job_type === "string" ? req.query.job_type : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    let query = db_1.db
        .selectFrom("index_jobs")
        .innerJoin("sites", "sites.id", "index_jobs.site_id")
        .where("sites.workspace_id", "=", workspace.id);
    if (siteId)
        query = query.where("index_jobs.site_id", "=", siteId);
    if (status)
        query = query.where("index_jobs.status", "=", status);
    if (jobType)
        query = query.where("index_jobs.job_type", "=", jobType);
    const totalRow = await query
        .select((0, kysely_1.sql) `COUNT(index_jobs.id)`.as("total"))
        .executeTakeFirst();
    const total = Number(totalRow?.total ?? 0);
    const jobs = await query
        .selectAll("index_jobs")
        .orderBy("index_jobs.created_at", "desc")
        .offset((page - 1) * PER_PAGE)
        .limit(PER_PAGE)
        .execute();
    const sites = await (0, sites_1.listSites)(workspace.id);
    const siteMap = Object.fromEntries(sites.map((s) => [s.id, s]));
    const activity = await db_1.db
        .selectFrom("activity_log")
        .selectAll()
        .where("workspace_id", "=", workspace.id)
        .orderBy("created_at", "desc")
        .limit(25)
        .execute();
    res.render("history.html", (0, templating_1.baseContext)(req, {
        user: req.user,
        workspace,
        jobs,
        activity,
        sites,
        site_map: siteMap,
        total,
        page,
        pages: Math.max(1, Math.ceil(total / PER_PAGE)),
        filter_site: siteId,
        filter_status: status,
        filter_type: jobType,
        statuses: Object.values(types_1.JobStatus),
        job_types: Object.values(types_1.JobType),
        totals: await (0, stats_1.jobTotals)(workspace.id, 30),
        active_page: "history",
    }));
}));
//# sourceMappingURL=history.js.map