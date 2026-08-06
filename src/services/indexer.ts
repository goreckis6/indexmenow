import { config } from "../config";
import { db } from "../db";
import {
  Engine,
  IndexStatus,
  JobStatus,
  JobType,
  type PageUrl,
  type Site,
  type Workspace,
} from "../db/types";
import { GoogleApiError } from "../google/errors";
import * as indexing from "../google/indexing";
import * as indexnow from "../google/indexnow";
import { getAccessToken } from "../google/oauth";
import * as gsc from "../google/searchConsole";
import { credentialsInfo, getServiceAccountToken } from "../google/serviceAccount";
import { decrypt } from "../lib/crypto";
import { logEvent } from "./activity";
import * as quota from "./quota";
import { scanAllSitemaps } from "./sitemaps";
import { recordSiteSnapshot } from "./stats";
import { pickUrlsForInspection, pickUrlsForSubmission } from "./urls";

const EXCLUSION_MARKERS = [
  "excluded",
  "duplicate",
  "alternate page",
  "noindex",
  "redirect",
  "not found",
  "soft 404",
  "blocked",
  "canonical",
];
const NOT_INDEXED_MARKERS = ["not indexed", "unknown to google", "discovered", "crawled -"];

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export interface ResolvedToken {
  token: string;
  label: string;
}

/**
 * Konto serwisowe ma wlasny limit zgloszen, wiec ma pierwszenstwo przed
 * tokenem OAuth uzytkownika - dzieki temu limit konta Google zostaje wolny
 * na inspekcje URL-i.
 */
export async function resolveIndexingToken(
  userId: number,
  userEmail: string,
  workspace: Pick<Workspace, "id">,
): Promise<ResolvedToken> {
  const account = await db
    .selectFrom("service_accounts")
    .selectAll()
    .where("workspace_id", "=", workspace.id)
    .where("is_active", "=", true)
    // Najdawniej uzywane konto idzie pierwsze, zeby rozlozyc obciazenie.
    .orderBy("last_used_at", "asc")
    .executeTakeFirst();

  if (account) {
    const privateKey = decrypt(account.private_key_enc);
    if (privateKey) {
      const info = credentialsInfo(account.client_email, privateKey, account.project_id);
      const token = await getServiceAccountToken(info);
      await db
        .updateTable("service_accounts")
        .set({ last_used_at: new Date() })
        .where("id", "=", account.id)
        .execute();
      return { token, label: `service-account:${account.client_email}` };
    }
  }

  return { token: await getAccessToken(userId), label: `oauth:${userEmail}` };
}

export function mapIndexStatus(
  verdict: string | undefined,
  coverageState: string | undefined,
): IndexStatus {
  const coverage = (coverageState ?? "").toLowerCase();
  if (verdict === "PASS") return IndexStatus.INDEXED;
  if (NOT_INDEXED_MARKERS.some((marker) => coverage.includes(marker))) {
    return IndexStatus.NOT_INDEXED;
  }
  if (EXCLUSION_MARKERS.some((marker) => coverage.includes(marker))) return IndexStatus.EXCLUDED;
  if (verdict === "FAIL" || verdict === "NEUTRAL" || verdict === "PARTIAL") {
    return IndexStatus.NOT_INDEXED;
  }
  return IndexStatus.UNKNOWN;
}

function trim(value: string | undefined, length: number): string | null {
  if (!value) return null;
  return value.slice(0, length) || null;
}

export interface InspectOutcome {
  status: JobStatus;
  indexStatus: IndexStatus;
  message: string;
}

export async function inspectSingle(
  userId: number,
  site: Site,
  page: PageUrl,
  triggeredBy = "manual",
): Promise<InspectOutcome> {
  const inserted = await db
    .insertInto("index_jobs")
    .values({
      site_id: site.id,
      url_id: page.id,
      target: page.url.slice(0, 2048),
      job_type: JobType.INSPECT,
      engine: Engine.GOOGLE,
      status: JobStatus.RUNNING,
      triggered_by: triggeredBy,
    })
    .executeTakeFirst();
  const jobId = Number(inserted.insertId);

  const started = process.hrtime.bigint();
  let jobStatus: JobStatus = JobStatus.SUCCESS;
  let message = "";
  let indexStatus: IndexStatus = page.index_status;
  let payload: unknown = null;

  try {
    const token = await getAccessToken(userId);
    const result = await gsc.inspectUrl(token, site.property_url, page.url);
    const statusResult = result.inspectionResult?.indexStatusResult ?? {};

    indexStatus = mapIndexStatus(statusResult.verdict, statusResult.coverageState);
    const lastCrawl = statusResult.lastCrawlTime ? new Date(statusResult.lastCrawlTime) : null;

    await db
      .updateTable("urls")
      .set({
        index_status: indexStatus,
        verdict: trim(statusResult.verdict, 32),
        coverage_state: trim(statusResult.coverageState, 255),
        robots_state: trim(statusResult.robotsTxtState, 64),
        page_fetch_state: trim(statusResult.pageFetchState, 64),
        canonical_google: trim(statusResult.googleCanonical, 2048),
        canonical_user: trim(statusResult.userCanonical, 2048),
        last_checked_at: new Date(),
        last_crawl_at: lastCrawl && !Number.isNaN(lastCrawl.getTime()) ? lastCrawl : null,
        error_message: null,
      })
      .where("id", "=", page.id)
      .execute();

    message = statusResult.coverageState ?? indexStatus;
    payload = statusResult;
  } catch (error) {
    const reason = error instanceof GoogleApiError ? error.toString() : String(error);
    jobStatus = JobStatus.FAILED;
    message = reason;
    // Nieudana inspekcja tez liczy sie jako sprawdzenie - inaczej ten sam
    // adres blokowalby kolejke przy kazdym przebiegu.
    await db
      .updateTable("urls")
      .set({
        last_checked_at: new Date(),
        error_message: reason.slice(0, 500),
        ...(page.index_status === IndexStatus.UNKNOWN
          ? { index_status: IndexStatus.ERROR }
          : {}),
      })
      .where("id", "=", page.id)
      .execute();
    if (page.index_status === IndexStatus.UNKNOWN) indexStatus = IndexStatus.ERROR;
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  await db
    .updateTable("index_jobs")
    .set({
      status: jobStatus,
      message: message.slice(0, 2000),
      payload: payload === null ? null : JSON.stringify(payload),
      duration_ms: Math.round(durationMs * 10) / 10,
      finished_at: new Date(),
    })
    .where("id", "=", jobId)
    .execute();

  return { status: jobStatus, indexStatus, message };
}

export interface InspectSummary {
  checked: number;
  indexed: number;
  not_indexed: number;
  excluded: number;
  errors: number;
}

export async function inspectBatch(
  userId: number,
  site: Site,
  limit = config.inspectionBatchSize,
  triggeredBy = "manual",
): Promise<InspectSummary> {
  const pages = await pickUrlsForInspection(site.id, limit, config.recheckAfterDays);
  const summary: InspectSummary = {
    checked: 0,
    indexed: 0,
    not_indexed: 0,
    excluded: 0,
    errors: 0,
  };

  for (const page of pages) {
    const outcome = await inspectSingle(userId, site, page, triggeredBy);
    summary.checked += 1;
    if (outcome.status === JobStatus.FAILED) {
      summary.errors += 1;
      // Po wyczerpaniu limitu dalsze proby tylko generuja bledy.
      if (outcome.message.toLowerCase().includes("quota")) break;
    } else if (outcome.indexStatus === IndexStatus.INDEXED) {
      summary.indexed += 1;
    } else if (outcome.indexStatus === IndexStatus.EXCLUDED) {
      summary.excluded += 1;
    } else {
      summary.not_indexed += 1;
    }
    await sleep(config.apiThrottleSeconds);
  }

  await recordSiteSnapshot(site, 0, summary.checked);
  return summary;
}

export interface SubmitOutcome {
  status: JobStatus;
  message: string;
}

export interface SubmitContext {
  userId: number;
  userEmail: string;
  workspace: Pick<Workspace, "id" | "daily_quota">;
  /** Token pobrany raz na cala partie; bez niego zostanie ustalony tutaj. */
  resolved?: ResolvedToken;
}

export async function submitSingle(
  ctx: SubmitContext,
  site: Site,
  page: PageUrl | null,
  target: string,
  jobType: JobType = JobType.URL_UPDATED,
  triggeredBy = "manual",
): Promise<SubmitOutcome> {
  const { workspace } = ctx;
  const inserted = await db
    .insertInto("index_jobs")
    .values({
      site_id: site.id,
      url_id: page?.id ?? null,
      target: target.slice(0, 2048),
      job_type: jobType,
      engine: Engine.GOOGLE,
      status: JobStatus.RUNNING,
      triggered_by: triggeredBy,
    })
    .executeTakeFirst();
  const jobId = Number(inserted.insertId);

  const started = process.hrtime.bigint();
  let status: JobStatus;
  let message: string;
  let payload: unknown = null;
  let credentialLabel = ctx.resolved?.label ?? "";

  if ((await quota.remaining(workspace)) <= 0) {
    status = JobStatus.SKIPPED;
    message = "Wyczerpany dzienny limit zgloszen do Google Indexing API.";
  } else {
    try {
      const credential =
        ctx.resolved ?? (await resolveIndexingToken(ctx.userId, ctx.userEmail, workspace));
      credentialLabel = credential.label;
      const response = await indexing.publishUrl(
        credential.token,
        target,
        jobType === JobType.URL_DELETED ? "URL_DELETED" : "URL_UPDATED",
      );
      await quota.consume(workspace.id, 1, Engine.GOOGLE);

      status = JobStatus.SUCCESS;
      message = "Zgloszono do Google Indexing API";
      payload = { response, credential: credential.label };

      if (page) {
        await db
          .updateTable("urls")
          .set({
            last_submitted_at: new Date(),
            submit_count: (page.submit_count ?? 0) + 1,
          })
          .where("id", "=", page.id)
          .execute();
      }
    } catch (error) {
      status = JobStatus.FAILED;
      message = error instanceof GoogleApiError ? error.toString() : String(error);
      payload = {
        credential: credentialLabel,
        error: error instanceof GoogleApiError ? error.payload : String(error),
      };
    }
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  await db
    .updateTable("index_jobs")
    .set({
      status,
      message: message.slice(0, 2000),
      payload: payload === null ? null : JSON.stringify(payload),
      duration_ms: Math.round(durationMs * 10) / 10,
      finished_at: new Date(),
    })
    .where("id", "=", jobId)
    .execute();

  return { status, message };
}

export interface SubmitSummary {
  submitted: number;
  failed: number;
  skipped: number;
  messages: string[];
}

export async function submitBatch(
  userId: number,
  userEmail: string,
  workspace: Pick<Workspace, "id" | "daily_quota">,
  site: Site,
  pages: PageUrl[],
  jobType: JobType = JobType.URL_UPDATED,
  triggeredBy = "manual",
): Promise<SubmitSummary> {
  const summary: SubmitSummary = { submitted: 0, failed: 0, skipped: 0, messages: [] };
  if (pages.length === 0) return summary;

  let resolved: ResolvedToken;
  try {
    // Token pobierany raz na cala partie - inaczej kazdy adres oznaczalby
    // dodatkowe zapytanie o token.
    resolved = await resolveIndexingToken(userId, userEmail, workspace);
  } catch (error) {
    summary.failed = pages.length;
    summary.messages.push(error instanceof GoogleApiError ? error.toString() : String(error));
    return summary;
  }

  const ctx: SubmitContext = { userId, userEmail, workspace, resolved };
  for (const page of pages) {
    const outcome = await submitSingle(ctx, site, page, page.url, jobType, triggeredBy);

    if (outcome.status === JobStatus.SUCCESS) {
      summary.submitted += 1;
    } else if (outcome.status === JobStatus.SKIPPED) {
      summary.skipped += 1;
      summary.messages.push(outcome.message);
      break;
    } else {
      summary.failed += 1;
      if (outcome.message) summary.messages.push(outcome.message);
      const lower = outcome.message.toLowerCase();
      if (lower.includes("quota") || outcome.message.includes("429")) break;
    }
    await sleep(config.apiThrottleSeconds);
  }

  await db
    .updateTable("sites")
    .set({ last_index_run_at: new Date() })
    .where("id", "=", site.id)
    .execute();
  await recordSiteSnapshot(site, summary.submitted, 0);
  return summary;
}

export async function submitIndexNow(
  site: Site,
  urls: string[],
): Promise<indexnow.IndexNowResult> {
  if (!site.indexnow_key) {
    return { ok: false, status: 0, message: "Brak klucza IndexNow dla tej strony.", count: 0 };
  }
  if (urls.length === 0) {
    return { ok: false, status: 0, message: "Brak URL-i do zgloszenia.", count: 0 };
  }

  const keyLocation = indexnow.keyFileUrl(site.home_url, site.indexnow_key);
  const inserted = await db
    .insertInto("index_jobs")
    .values({
      site_id: site.id,
      target: `${urls.length} URL-i`,
      job_type: JobType.INDEXNOW,
      engine: Engine.BING,
      status: JobStatus.RUNNING,
    })
    .executeTakeFirst();
  const jobId = Number(inserted.insertId);

  let result: indexnow.IndexNowResult;
  try {
    result = await indexnow.submitUrls(urls, site.indexnow_key, keyLocation);
  } catch (error) {
    result = {
      ok: false,
      status: 0,
      message: error instanceof GoogleApiError ? error.toString() : String(error),
      count: urls.length,
    };
  }

  await db
    .updateTable("index_jobs")
    .set({
      status: result.ok ? JobStatus.SUCCESS : JobStatus.FAILED,
      message: `${result.message} (${result.count} URL-i)`,
      payload: JSON.stringify(result),
      finished_at: new Date(),
    })
    .where("id", "=", jobId)
    .execute();

  return result;
}

export interface PipelineReport {
  site: string;
  scan?: unknown;
  inspection?: unknown;
  submission?: unknown;
  indexnow?: unknown;
}

/** Pelny cykl dla jednej strony: odswiez URL-e, sprawdz, zglos brakujace. */
export async function runSitePipeline(
  userId: number,
  userEmail: string,
  workspace: Pick<Workspace, "id" | "daily_quota">,
  site: Site,
  triggeredBy = "auto",
  scanSitemaps = true,
): Promise<PipelineReport> {
  const report: PipelineReport = { site: site.display_name };

  if (scanSitemaps) {
    try {
      report.scan = await scanAllSitemaps(site);
    } catch (error) {
      // Blad skanu nie moze zatrzymac indeksowania tego, co juz jest w bazie.
      report.scan = { error: error instanceof Error ? error.message : String(error) };
      console.error(`Skan sitemap nie udal sie dla ${site.display_name}`, error);
    }
  }

  try {
    report.inspection = await inspectBatch(
      userId,
      site,
      config.inspectionBatchSize,
      triggeredBy,
    );
  } catch (error) {
    report.inspection = { error: error instanceof Error ? error.message : String(error) };
  }

  const budget = Math.min(site.daily_limit, await quota.remaining(workspace));
  if (budget <= 0) {
    report.submission = { skipped: true, reason: "Brak dostepnego limitu na dzis." };
    return report;
  }

  const pages = await pickUrlsForSubmission(site.id, budget);
  const submission = await submitBatch(
    userId,
    userEmail,
    workspace,
    site,
    pages,
    JobType.URL_UPDATED,
    triggeredBy,
  );
  report.submission = submission;

  if (site.indexnow_enabled && pages.length > 0) {
    report.indexnow = await submitIndexNow(site, pages.map((p) => p.url));
  }

  await logEvent(
    `Auto-indeksowanie ${site.display_name}: zgloszono ${submission.submitted} URL-i.`,
    { workspaceId: workspace.id, category: "indexing", details: report },
  );
  return report;
}
