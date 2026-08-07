import { sql } from "kysely";
import { db } from "../db/index.js";
import { IndexStatus, type PageUrl, type Site } from "../db/types.js";
import { sha256 } from "../lib/crypto.js";
import { daysAgo } from "../lib/dates.js";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
]);

export function normalizeUrl(raw: string): string | null {
  let value = (raw ?? "").trim();
  if (!value || value.startsWith("#")) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value.replace(/^\/+/, "")}`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  // Host bez kropki to prawie zawsze literowka we wklejonej liscie, a nie
  // adres. Bez tej kontroli "nie-adres" trafialoby do bazy jako
  // https://nie-adres/ i marnowalo dzienny limit zgloszen.
  if (!parsed.hostname.includes(".") || parsed.hostname.startsWith(".") || parsed.hostname.endsWith("."))
    return null;

  // Parametry sledzace nie tworza nowej strony, a rozbijalyby ten sam adres
  // na kilka wpisow i marnowaly dzienny limit zgloszen.
  for (const param of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(param.toLowerCase())) parsed.searchParams.delete(param);
  }
  parsed.hash = "";
  return parsed.toString();
}

/** Przyjmuje adresy rozdzielone nowa linia, przecinkiem albo spacja. */
export function parseUrlBlob(blob: string): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of (blob ?? "").split(/[\s,]+/)) {
    const normalized = normalizeUrl(token);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }
  return unique;
}

export interface AddUrlsResult {
  added: number;
  duplicates: number;
  refreshed: number;
  total: number;
}

export async function addUrls(
  site: Pick<Site, "id">,
  urls: string[],
  source = "manual",
  lastmodMap: Map<string, Date> = new Map(),
  priority = 0,
): Promise<AddUrlsResult> {
  const result: AddUrlsResult = { added: 0, duplicates: 0, refreshed: 0, total: urls.length };
  if (urls.length === 0) return result;

  const existingRows = await db
    .selectFrom("urls")
    .select(["url", "url_hash", "lastmod"])
    .where("site_id", "=", site.id)
    .execute();
  const existing = new Map(existingRows.map((row) => [row.url_hash, row]));

  const toInsert: {
    site_id: number;
    url: string;
    url_hash: string;
    source: string;
    priority: number;
    lastmod: Date | null;
  }[] = [];

  for (const url of urls) {
    const hash = sha256(url);
    const found = existing.get(hash);
    if (found) {
      result.duplicates += 1;
      const lastmod = lastmodMap.get(url);
      if (lastmod && found.lastmod?.getTime() !== lastmod.getTime()) {
        await db
          .updateTable("urls")
          .set({ lastmod })
          .where("site_id", "=", site.id)
          .where("url_hash", "=", hash)
          .execute();
        result.refreshed += 1;
      }
      continue;
    }

    toInsert.push({
      site_id: site.id,
      url: url.slice(0, 2048),
      url_hash: hash,
      source,
      priority,
      lastmod: lastmodMap.get(url) ?? null,
    });
    existing.set(hash, { url, url_hash: hash, lastmod: null });
    result.added += 1;
  }

  // Sitemapa moze miec dziesiatki tysiecy adresow, a MySQL ma limit rozmiaru
  // pojedynczego zapytania - stad porcje po 500.
  for (let i = 0; i < toInsert.length; i += 500) {
    await db.insertInto("urls").values(toInsert.slice(i, i + 500)).execute();
  }

  return result;
}

export interface UrlStats extends Record<string, number> {
  total: number;
  coverage: number;
}

function emptyCounts(): Record<string, number> {
  return Object.fromEntries(Object.values(IndexStatus).map((status) => [status, 0]));
}

function summarize(rows: { index_status: string; total: number | string }[]): UrlStats {
  const counts = emptyCounts();
  for (const row of rows) counts[row.index_status] = Number(row.total);

  const total = Object.values(IndexStatus).reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  // Adresy o nieznanym statusie nie wchodza do pokrycia - inaczej swiezo dodana
  // strona pokazywalaby 0% mimo tego, ze nic jeszcze nie sprawdzono.
  const known = total - (counts[IndexStatus.UNKNOWN] ?? 0);
  const coverage = known ? Math.round(((counts[IndexStatus.INDEXED] ?? 0) / known) * 1000) / 10 : 0;

  return { ...counts, total, coverage } as UrlStats;
}

export async function siteUrlStats(siteId: number): Promise<UrlStats> {
  const rows = await db
    .selectFrom("urls")
    .select(["index_status", sql<number>`COUNT(id)`.as("total")])
    .where("site_id", "=", siteId)
    .where("is_active", "=", true)
    .groupBy("index_status")
    .execute();
  return summarize(rows);
}

export async function workspaceUrlStats(workspaceId: number): Promise<UrlStats> {
  const rows = await db
    .selectFrom("urls")
    .innerJoin("sites", "sites.id", "urls.site_id")
    .select(["urls.index_status as index_status", sql<number>`COUNT(urls.id)`.as("total")])
    .where("sites.workspace_id", "=", workspaceId)
    .where("urls.is_active", "=", true)
    .groupBy("urls.index_status")
    .execute();
  return summarize(rows);
}

/** Najpierw nigdy nie sprawdzane, potem najbardziej przedawnione. */
export async function pickUrlsForInspection(
  siteId: number,
  limit: number,
  recheckDays: number,
): Promise<PageUrl[]> {
  const neverChecked = await db
    .selectFrom("urls")
    .selectAll()
    .where("site_id", "=", siteId)
    .where("is_active", "=", true)
    .where("last_checked_at", "is", null)
    .orderBy("priority", "desc")
    .orderBy("id")
    .limit(limit)
    .execute();

  if (neverChecked.length >= limit) return neverChecked;

  const stale = await db
    .selectFrom("urls")
    .selectAll()
    .where("site_id", "=", siteId)
    .where("is_active", "=", true)
    .where("last_checked_at", "is not", null)
    .where("last_checked_at", "<", daysAgo(recheckDays))
    .where("index_status", "!=", IndexStatus.INDEXED)
    .orderBy("last_checked_at")
    .limit(limit - neverChecked.length)
    .execute();

  return [...neverChecked, ...stale];
}

/** Najpierw potwierdzone niezaindeksowane, potem o nieznanym statusie. */
export async function pickUrlsForSubmission(siteId: number, limit: number): Promise<PageUrl[]> {
  const notIndexed = await db
    .selectFrom("urls")
    .selectAll()
    .where("site_id", "=", siteId)
    .where("is_active", "=", true)
    .where("index_status", "in", [IndexStatus.NOT_INDEXED, IndexStatus.ERROR])
    .orderBy("priority", "desc")
    // Adresy nigdy nie zglaszane maja pierwszenstwo przed tymi, ktore juz raz poszly.
    .orderBy(sql`last_submitted_at IS NOT NULL`)
    .orderBy("last_submitted_at")
    .orderBy("id")
    .limit(limit)
    .execute();

  if (notIndexed.length >= limit) return notIndexed;

  const unknown = await db
    .selectFrom("urls")
    .selectAll()
    .where("site_id", "=", siteId)
    .where("is_active", "=", true)
    .where("index_status", "=", IndexStatus.UNKNOWN)
    .where("last_submitted_at", "is", null)
    .orderBy("priority", "desc")
    .orderBy("id")
    .limit(limit - notIndexed.length)
    .execute();

  return [...notIndexed, ...unknown];
}

export interface ListUrlsOptions {
  siteId?: number;
  workspaceId: number;
  status?: string;
  search?: string;
  page?: number;
  perPage?: number;
}

export async function listUrls(options: ListUrlsOptions) {
  const { workspaceId, siteId, status, search, page = 1, perPage = 50 } = options;

  let query = db
    .selectFrom("urls")
    .innerJoin("sites", "sites.id", "urls.site_id")
    .where("sites.workspace_id", "=", workspaceId);

  if (siteId) query = query.where("urls.site_id", "=", siteId);
  if (status && status !== "ALL") query = query.where("urls.index_status", "=", status as IndexStatus);
  if (search) query = query.where("urls.url", "like", `%${search}%`);

  const totalRow = await query
    .select(sql<number>`COUNT(urls.id)`.as("total"))
    .executeTakeFirst();
  const total = Number(totalRow?.total ?? 0);

  const rows = await query
    .selectAll("urls")
    .select(["sites.display_name as site_name", "sites.property_url as site_property"])
    .orderBy("urls.last_checked_at", "desc")
    .orderBy("urls.id", "desc")
    .limit(perPage)
    .offset((page - 1) * perPage)
    .execute();

  return { rows, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}
