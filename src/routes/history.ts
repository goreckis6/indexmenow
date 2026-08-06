import { Router } from "express";
import { sql } from "kysely";
import { db } from "../db";
import { JobStatus, JobType } from "../db/types";
import { asyncHandler } from "../middleware/auth";
import { listSites } from "../services/sites";
import { jobTotals } from "../services/stats";
import { baseContext } from "../templating";
import { panelAuth } from "./auth";

export const historyRouter = Router();
historyRouter.use(...panelAuth);

const PER_PAGE = 60;

historyRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const siteId = Number(req.query.site_id) || 0;
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const jobType = typeof req.query.job_type === "string" ? req.query.job_type : "";
    const page = Math.max(1, Number(req.query.page) || 1);

    let query = db
      .selectFrom("index_jobs")
      .innerJoin("sites", "sites.id", "index_jobs.site_id")
      .where("sites.workspace_id", "=", workspace.id);
    if (siteId) query = query.where("index_jobs.site_id", "=", siteId);
    if (status) query = query.where("index_jobs.status", "=", status as JobStatus);
    if (jobType) query = query.where("index_jobs.job_type", "=", jobType as JobType);

    const totalRow = await query
      .select(sql<number>`COUNT(index_jobs.id)`.as("total"))
      .executeTakeFirst();
    const total = Number(totalRow?.total ?? 0);

    const jobs = await query
      .selectAll("index_jobs")
      .orderBy("index_jobs.created_at", "desc")
      .offset((page - 1) * PER_PAGE)
      .limit(PER_PAGE)
      .execute();

    const sites = await listSites(workspace.id);
    const siteMap = Object.fromEntries(sites.map((s) => [s.id, s]));

    const activity = await db
      .selectFrom("activity_log")
      .selectAll()
      .where("workspace_id", "=", workspace.id)
      .orderBy("created_at", "desc")
      .limit(25)
      .execute();

    res.render(
      "history.html",
      baseContext(req, {
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
        statuses: Object.values(JobStatus),
        job_types: Object.values(JobType),
        totals: await jobTotals(workspace.id, 30),
        active_page: "history",
      }),
    );
  }),
);
