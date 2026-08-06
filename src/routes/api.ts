import { Router } from "express";
import { sql } from "kysely";
import { db } from "../db";
import { IndexStatus } from "../db/types";
import {
  asyncHandler,
  loadUser,
  requireApiAuth,
  requireSite,
  resolveWorkspace,
} from "../middleware/auth";
import * as quota from "../services/quota";
import { nextRunTimes, runningTasks } from "../services/scheduler";
import { siteUrlStats, workspaceUrlStats } from "../services/urls";
import { workspaceIndexingHistory } from "../services/stats";

export const apiRouter = Router();
apiRouter.use(loadUser, requireApiAuth, resolveWorkspace);

apiRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const used = await quota.getUsage(workspace.id);
    const siteCount = await db
      .selectFrom("sites")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where("workspace_id", "=", workspace.id)
      .executeTakeFirst();

    res.json({
      workspace: { id: workspace.id, name: workspace.name },
      urls: await workspaceUrlStats(workspace.id),
      quota: {
        used,
        limit: workspace.daily_quota,
        remaining: Math.max(0, workspace.daily_quota - used),
      },
      sites: Number(siteCount?.total ?? 0),
      history: await workspaceIndexingHistory(workspace.id, 30),
      submissions: await quota.submissionsLastDays(workspace.id, 30),
    });
  }),
);

apiRouter.get(
  "/tasks",
  asyncHandler(async (req, res) => {
    const running = runningTasks();
    const recent = await db
      .selectFrom("index_jobs")
      .innerJoin("sites", "sites.id", "index_jobs.site_id")
      .selectAll("index_jobs")
      .where("sites.workspace_id", "=", req.workspace!.id)
      .orderBy("index_jobs.created_at", "desc")
      .limit(8)
      .execute();

    res.json({
      running,
      busy: running.length > 0,
      next_runs: nextRunTimes(),
      recent: recent.map((job) => ({
        id: job.id,
        target: job.target,
        type: job.job_type,
        status: job.status,
        message: job.message,
        created_at: job.created_at?.toISOString() ?? null,
      })),
    });
  }),
);

apiRouter.get(
  "/sites/:siteId/summary",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    res.json({
      id: site.id,
      name: site.display_name,
      property: site.property_url,
      auto_index: site.auto_index,
      stats: await siteUrlStats(site.id),
      last_scan_at: site.last_scan_at?.toISOString() ?? null,
      last_index_run_at: site.last_index_run_at?.toISOString() ?? null,
      busy: runningTasks().includes(`site:${site.id}`),
    });
  }),
);

apiRouter.get(
  "/urls/:urlId",
  asyncHandler(async (req, res) => {
    const page = await db
      .selectFrom("urls")
      .innerJoin("sites", "sites.id", "urls.site_id")
      .selectAll("urls")
      .where("urls.id", "=", Number(req.params.urlId))
      .where("sites.workspace_id", "=", req.workspace!.id)
      .executeTakeFirst();

    if (!page) return res.status(404).json({ detail: "Nie znaleziono" });

    const jobs = await db
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
  }),
);

apiRouter.get(
  "/status-breakdown",
  asyncHandler(async (req, res) => {
    const rows = await db
      .selectFrom("urls")
      .innerJoin("sites", "sites.id", "urls.site_id")
      .select(["urls.index_status as status", sql<number>`COUNT(urls.id)`.as("total")])
      .where("sites.workspace_id", "=", req.workspace!.id)
      .groupBy("urls.index_status")
      .execute();

    const counts: Record<string, number> = Object.fromEntries(
      Object.values(IndexStatus).map((s) => [s, 0]),
    );
    for (const row of rows) counts[row.status] = Number(row.total);
    res.json(counts);
  }),
);
