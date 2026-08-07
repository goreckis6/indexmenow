import { db } from "../db/index.js";
import type { Site, Workspace } from "../db/types.js";
import * as gsc from "../google/searchConsole.js";
import { getAccessToken } from "../google/oauth.js";
import { generateIndexNowKey } from "../lib/crypto.js";
import { logEvent } from "./activity.js";

export function propertyToHomeUrl(propertyUrl: string): string {
  if (propertyUrl.startsWith("sc-domain:")) {
    return `https://${propertyUrl.slice("sc-domain:".length)}/`;
  }
  return propertyUrl.endsWith("/") ? propertyUrl : `${propertyUrl}/`;
}

export function propertyToDisplayName(propertyUrl: string): string {
  if (propertyUrl.startsWith("sc-domain:")) return propertyUrl.slice("sc-domain:".length);
  try {
    const parsed = new URL(propertyUrl);
    const path = parsed.pathname.replace(/\/+$/, "");
    return path ? `${parsed.host}${path}` : parsed.host;
  } catch {
    return propertyUrl;
  }
}

export function normalizeProperty(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("sc-domain:")) {
    const domain = value.slice("sc-domain:".length).trim().toLowerCase().replace(/^www\./, "");
    return `sc-domain:${domain}`;
  }
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withScheme);
    const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return withScheme;
  }
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  total: number;
}

/** Zaciaga wszystkie wlasciwosci Search Console, do ktorych uzytkownik ma dostep. */
export async function importSitesFromGsc(
  userId: number,
  workspace: Pick<Workspace, "id">,
): Promise<ImportResult> {
  const token = await getAccessToken(userId);
  const entries = await gsc.listSites(token);

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, total: entries.length };

  for (const entry of entries) {
    const propertyUrl = entry.siteUrl;
    const permission = entry.permissionLevel ?? "";
    if (!propertyUrl) continue;
    // Bez weryfikacji wlasciwosci Search Console nie pozwoli nic zrobic.
    if (permission === "siteUnverifiedUser") {
      result.skipped += 1;
      continue;
    }

    const existing = await db
      .selectFrom("sites")
      .select("id")
      .where("workspace_id", "=", workspace.id)
      .where("property_url", "=", propertyUrl)
      .executeTakeFirst();

    if (existing) {
      await db
        .updateTable("sites")
        .set({ permission_level: permission, home_url: propertyToHomeUrl(propertyUrl) })
        .where("id", "=", existing.id)
        .execute();
      result.updated += 1;
    } else {
      await db
        .insertInto("sites")
        .values({
          workspace_id: workspace.id,
          property_url: propertyUrl,
          display_name: propertyToDisplayName(propertyUrl),
          home_url: propertyToHomeUrl(propertyUrl),
          permission_level: permission,
          indexnow_key: generateIndexNowKey(),
          auto_index: true,
          daily_limit: 50,
        })
        .execute();
      result.created += 1;
    }
  }

  await logEvent(
    `Zaimportowano strony z Search Console: ${result.created} nowych, ${result.updated} zaktualizowanych.`,
    { workspaceId: workspace.id, category: "sites", details: result },
  );
  return result;
}

export async function createSite(workspaceId: number, propertyUrl: string): Promise<Site> {
  const normalized = normalizeProperty(propertyUrl);
  const existing = await db
    .selectFrom("sites")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("property_url", "=", normalized)
    .executeTakeFirst();
  if (existing) return existing;

  const inserted = await db
    .insertInto("sites")
    .values({
      workspace_id: workspaceId,
      property_url: normalized,
      display_name: propertyToDisplayName(normalized),
      home_url: propertyToHomeUrl(normalized),
      permission_level: "manual",
      indexnow_key: generateIndexNowKey(),
      auto_index: true,
      daily_limit: 50,
    })
    .executeTakeFirst();

  return db
    .selectFrom("sites")
    .selectAll()
    .where("id", "=", Number(inserted.insertId))
    .executeTakeFirstOrThrow();
}

/** Potwierdza, ze zalogowane konto nadal ma dostep do wlasciwosci. */
export async function verifySiteAccess(userId: number, site: Site): Promise<gsc.SiteEntry> {
  const token = await getAccessToken(userId);
  const entry = await gsc.getSite(token, site.property_url);
  if (entry.permissionLevel) {
    await db
      .updateTable("sites")
      .set({ permission_level: entry.permissionLevel })
      .where("id", "=", site.id)
      .execute();
  }
  return entry;
}

export function listSites(workspaceId: number): Promise<Site[]> {
  return db
    .selectFrom("sites")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .orderBy("priority", "desc")
    .orderBy("display_name")
    .execute();
}

export function getSite(siteId: number, workspaceId: number): Promise<Site | undefined> {
  return db
    .selectFrom("sites")
    .selectAll()
    .where("id", "=", siteId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
}

export async function deleteSite(siteId: number, workspaceId: number): Promise<void> {
  await db.deleteFrom("sites").where("id", "=", siteId).where("workspace_id", "=", workspaceId).execute();
}
