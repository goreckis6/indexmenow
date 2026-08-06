import { Router } from "express";
import { sql } from "kysely";
import { Engine } from "../db/types";
import { db } from "../db";
import { asyncHandler } from "../middleware/auth";
import * as quota from "../services/quota";
import { nextRunTimes, runningTasks } from "../services/scheduler";
import { jobTotals, recentJobs, workspaceIndexingHistory } from "../services/stats";
import { workspaceUrlStats } from "../services/urls";
import { listWorkspaces } from "../services/workspaces";
import { baseContext } from "../templating";
import { panelAuth } from "./auth";

export const dashboardRouter = Router();
dashboardRouter.use(...panelAuth);

dashboardRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const user = req.user!;

    const sites = await db
      .selectFrom("sites")
      .selectAll()
      .where("workspace_id", "=", workspace.id)
      .orderBy("priority", "desc")
      .orderBy("display_name")
      .execute();

    const countRows = await db
      .selectFrom("urls")
      .innerJoin("sites", "sites.id", "urls.site_id")
      .select(["urls.site_id as site_id", sql<number>`COUNT(urls.id)`.as("total")])
      .where("sites.workspace_id", "=", workspace.id)
      .where("urls.is_active", "=", true)
      .groupBy("urls.site_id")
      .execute();
    const indexedRows = await db
      .selectFrom("urls")
      .innerJoin("sites", "sites.id", "urls.site_id")
      .select(["urls.site_id as site_id", sql<number>`COUNT(urls.id)`.as("total")])
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

    const usedToday = await quota.getUsage(workspace.id, Engine.GOOGLE);
    const stats = await workspaceUrlStats(workspace.id);

    res.render(
      "dashboard.html",
      baseContext(req, {
        user,
        workspace,
        workspaces: await listWorkspaces(user.id),
        stats,
        site_rows: siteRows,
        quota_used: usedToday,
        quota_limit: workspace.daily_quota,
        quota_percent: workspace.daily_quota
          ? Math.round((usedToday / workspace.daily_quota) * 100)
          : 0,
        history: await workspaceIndexingHistory(workspace.id, 30),
        submissions: await quota.submissionsLastDays(workspace.id, 30),
        jobs: await recentJobs(workspace.id, 12),
        job_totals: await jobTotals(workspace.id, 30),
        next_runs: nextRunTimes(),
        running: runningTasks(),
        active_page: "dashboard",
      }),
    );
  }),
);
