import { db } from "../db/index.js";
import { JobStatus, JobType, isDomainProperty, type Site, type Sitemap } from "../db/types.js";
import { GoogleApiError } from "../google/errors.js";
import { getAccessToken } from "../google/oauth.js";
import * as gsc from "../google/searchConsole.js";
import { sha256 } from "../lib/crypto.js";
import { parseDate } from "../lib/dates.js";
import { logEvent } from "./activity.js";
import * as sitemapParser from "./sitemapParser.js";
import { addUrls } from "./urls.js";

const USER_AGENT = "IndexMeNow/1.0 (+sitemap-crawler)";

function toInt(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function listSitemaps(siteId: number): Promise<Sitemap[]> {
  return db.selectFrom("sitemaps").selectAll().where("site_id", "=", siteId).orderBy("id").execute();
}

export function getSitemap(sitemapId: number, siteId: number): Promise<Sitemap | undefined> {
  return db
    .selectFrom("sitemaps")
    .selectAll()
    .where("id", "=", sitemapId)
    .where("site_id", "=", siteId)
    .executeTakeFirst();
}

/** Odzwierciedla liste sitemap, ktore Google juz zna. */
export async function syncFromGsc(userId: number, site: Site) {
  const token = await getAccessToken(userId);
  const entries = await gsc.listSitemaps(token, site.property_url);

  let created = 0;
  let updated = 0;

  for (const entry of entries) {
    const path = entry.path;
    if (!path) continue;
    const hash = sha256(path);

    const values = {
      is_pending: Boolean(entry.isPending),
      is_sitemaps_index: Boolean(entry.isSitemapsIndex),
      warnings: toInt(entry.warnings),
      errors: toInt(entry.errors),
      url_count: (entry.contents ?? []).reduce((sum, c) => sum + toInt(c.submitted), 0),
      last_submitted_at: parseDate(entry.lastSubmitted),
      last_downloaded_at: parseDate(entry.lastDownloaded),
    };

    const existing = await db
      .selectFrom("sitemaps")
      .select("id")
      .where("site_id", "=", site.id)
      .where("path_hash", "=", hash)
      .executeTakeFirst();

    if (existing) {
      await db.updateTable("sitemaps").set(values).where("id", "=", existing.id).execute();
      updated += 1;
    } else {
      await db
        .insertInto("sitemaps")
        .values({ site_id: site.id, path, path_hash: hash, source: "gsc", ...values })
        .execute();
      created += 1;
    }
  }

  return { created, updated, total: entries.length };
}

/** Sprawdza typowe sciezki sitemap i to, co ogłasza robots.txt. */
export async function discoverSitemaps(site: Site): Promise<string[]> {
  const found: string[] = [];

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
      if (response.ok) found.push(candidate);
    } catch {
      continue;
    }
  }

  for (const path of found) {
    const hash = sha256(path);
    const existing = await db
      .selectFrom("sitemaps")
      .select("id")
      .where("site_id", "=", site.id)
      .where("path_hash", "=", hash)
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto("sitemaps")
        .values({ site_id: site.id, path, path_hash: hash, source: "discovered" })
        .execute();
    }
  }

  return found;
}

export async function addSitemap(site: Site, path: string): Promise<Sitemap> {
  let clean = path.trim();
  if (!clean.startsWith("http")) {
    clean = `${site.home_url.replace(/\/+$/, "")}/${clean.replace(/^\/+/, "")}`;
  }
  const hash = sha256(clean);

  const existing = await db
    .selectFrom("sitemaps")
    .selectAll()
    .where("site_id", "=", site.id)
    .where("path_hash", "=", hash)
    .executeTakeFirst();
  if (existing) return existing;

  const inserted = await db
    .insertInto("sitemaps")
    .values({ site_id: site.id, path: clean, path_hash: hash, source: "manual" })
    .executeTakeFirst();

  return db
    .selectFrom("sitemaps")
    .selectAll()
    .where("id", "=", Number(inserted.insertId))
    .executeTakeFirstOrThrow();
}

export async function deleteSitemap(sitemapId: number, siteId: number): Promise<void> {
  await db.deleteFrom("sitemaps").where("id", "=", sitemapId).where("site_id", "=", siteId).execute();
}

async function runSitemapJob(
  site: Site,
  sitemap: Sitemap,
  jobType: JobType,
  action: (token: string) => Promise<unknown>,
  successMessage: string,
  userId: number,
) {
  const inserted = await db
    .insertInto("index_jobs")
    .values({
      site_id: site.id,
      target: sitemap.path.slice(0, 2048),
      job_type: jobType,
      status: JobStatus.RUNNING,
    })
    .executeTakeFirst();
  const jobId = Number(inserted.insertId);

  let status: JobStatus = JobStatus.SUCCESS;
  let message = successMessage;
  try {
    const token = await getAccessToken(userId);
    await action(token);
    if (jobType === JobType.SITEMAP_SUBMIT) {
      await db
        .updateTable("sitemaps")
        .set({ last_submitted_at: new Date() })
        .where("id", "=", sitemap.id)
        .execute();
    }
  } catch (error) {
    status = JobStatus.FAILED;
    message = error instanceof GoogleApiError ? error.toString() : String(error);
  }

  await db
    .updateTable("index_jobs")
    .set({ status, message, finished_at: new Date() })
    .where("id", "=", jobId)
    .execute();

  return { status, message };
}

export function submitToGoogle(userId: number, site: Site, sitemap: Sitemap) {
  return runSitemapJob(
    site,
    sitemap,
    JobType.SITEMAP_SUBMIT,
    (token) => gsc.submitSitemap(token, site.property_url, sitemap.path),
    "Sitemapa zgloszona do Google Search Console",
    userId,
  );
}

export function deleteFromGoogle(userId: number, site: Site, sitemap: Sitemap) {
  return runSitemapJob(
    site,
    sitemap,
    JobType.SITEMAP_DELETE,
    (token) => gsc.deleteSitemap(token, site.property_url, sitemap.path),
    "Sitemapa usunieta z Google Search Console",
    userId,
  );
}

export interface ScanOutcome {
  added: number;
  duplicates: number;
  refreshed: number;
  found: number;
  error?: string | null;
}

/** Pobiera sitemape i importuje wszystkie zawarte w niej adresy. */
export async function scanSitemap(site: Site, sitemap: Sitemap): Promise<ScanOutcome> {
  const result = await sitemapParser.crawlSitemap(sitemap.path);

  if (result.error && result.entries.length === 0) {
    await db
      .updateTable("sitemaps")
      .set({ errors: (sitemap.errors ?? 0) + 1 })
      .where("id", "=", sitemap.id)
      .execute();
    return { added: 0, duplicates: 0, refreshed: 0, found: 0, error: result.error };
  }

  // Sitemapa moze wymieniac adresy z innych domen - Google odrzuci takie
  // zgloszenie, wiec odsiewamy je zanim trafia do bazy.
  const domainProperty = isDomainProperty(site);
  const valid = result.entries.filter((entry) =>
    sitemapParser.urlBelongsToSite(entry.url, site.home_url, domainProperty),
  );

  const lastmodMap = new Map<string, Date>();
  for (const entry of valid) {
    if (entry.lastmod) lastmodMap.set(entry.url, entry.lastmod);
  }

  const outcome = await addUrls(
    site,
    valid.map((entry) => entry.url),
    "sitemap",
    lastmodMap,
  );

  const now = new Date();
  await db
    .updateTable("sitemaps")
    .set({
      url_count: valid.length,
      last_downloaded_at: now,
      is_sitemaps_index: result.isIndex,
    })
    .where("id", "=", sitemap.id)
    .execute();
  await db.updateTable("sites").set({ last_scan_at: now }).where("id", "=", site.id).execute();

  return { ...outcome, found: result.entries.length, error: result.error ?? null };
}

export interface ScanTotals {
  added: number;
  duplicates: number;
  found: number;
  sitemaps: number;
  errors: string[];
}

export async function scanAllSitemaps(site: Site): Promise<ScanTotals> {
  const totals: ScanTotals = { added: 0, duplicates: 0, found: 0, sitemaps: 0, errors: [] };

  let sitemaps = await db
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
    if (outcome.error) totals.errors.push(`${sitemap.path}: ${outcome.error}`);
  }

  await logEvent(`Skan sitemap dla ${site.display_name}: +${totals.added} nowych URL-i.`, {
    workspaceId: site.workspace_id,
    category: "sitemap",
    details: totals,
  });
  return totals;
}
