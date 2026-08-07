import { db } from "../db/index.js";
import type { PageUrl, Site, User, Workspace } from "../db/types.js";
import { logEvent } from "./activity.js";
import * as indexer from "./indexer.js";
import * as sitemaps from "./sitemaps.js";

async function loadSiteContext(siteId: number): Promise<{
  site: Site;
  workspace: Workspace;
  user: User;
}> {
  const site = await db.selectFrom("sites").selectAll().where("id", "=", siteId).executeTakeFirst();
  if (!site) throw new Error(`Site ${siteId} nie istnieje`);

  const workspace = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", site.workspace_id)
    .executeTakeFirstOrThrow();
  const user = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", workspace.user_id)
    .executeTakeFirstOrThrow();

  return { site, workspace, user };
}

export async function taskScanSitemaps(siteId: number): Promise<void> {
  const { site } = await loadSiteContext(siteId);
  await sitemaps.scanAllSitemaps(site);
}

export async function taskInspect(siteId: number, limit?: number): Promise<void> {
  const { site, user } = await loadSiteContext(siteId);
  const summary = await indexer.inspectBatch(user.id, site, limit, "manual");
  await logEvent(
    `Inspekcja ${site.display_name}: sprawdzono ${summary.checked} URL-i (${summary.indexed} zaindeksowanych).`,
    { workspaceId: site.workspace_id, category: "inspection", details: summary },
  );
}

export async function taskRunPipeline(siteId: number, scan = true): Promise<void> {
  const { site, workspace, user } = await loadSiteContext(siteId);
  await indexer.runSitePipeline(user.id, user.email, workspace, site, "manual", scan);
}

export async function taskSubmitUrls(siteId: number, urlIds: number[]): Promise<void> {
  const { site, workspace, user } = await loadSiteContext(siteId);
  let pages: PageUrl[] = [];
  if (urlIds.length > 0) {
    pages = await db
      .selectFrom("urls")
      .selectAll()
      .where("site_id", "=", site.id)
      .where("id", "in", urlIds)
      .execute();
  }
  const summary = await indexer.submitBatch(
    user.id,
    user.email,
    workspace,
    site,
    pages,
  );
  await logEvent(`Zgloszono ${summary.submitted} URL-i dla ${site.display_name}.`, {
    workspaceId: site.workspace_id,
    category: "indexing",
    details: summary,
  });
}

export async function taskInspectUrls(siteId: number, urlIds: number[]): Promise<void> {
  const { site, user } = await loadSiteContext(siteId);
  if (urlIds.length === 0) return;
  const pages = await db
    .selectFrom("urls")
    .selectAll()
    .where("site_id", "=", site.id)
    .where("id", "in", urlIds)
    .execute();
  for (const page of pages) {
    await indexer.inspectSingle(user.id, site, page, "manual");
  }
}

export async function taskRunAllSites(workspaceId: number): Promise<void> {
  const workspace = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  if (!workspace) return;

  const user = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", workspace.user_id)
    .executeTakeFirst();
  if (!user) return;

  const sites = await db
    .selectFrom("sites")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("is_active", "=", true)
    .execute();

  for (const site of sites) {
    try {
      await indexer.runSitePipeline(user.id, user.email, workspace, site, "manual");
    } catch (error) {
      console.error(`Pipeline nie powiodl sie dla strony ${site.id}`, error);
    }
  }
}
