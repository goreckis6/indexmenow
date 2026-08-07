import { sql } from "kysely";
import { db } from "../db/index.js";
import { Engine, JobStatus, type Workspace } from "../db/types.js";
import { dayRange, daysAgo, todayIso } from "../lib/dates.js";

export async function getUsage(
  workspaceId: number,
  engine: Engine = Engine.GOOGLE,
  day: string = todayIso(),
): Promise<number> {
  const row = await db
    .selectFrom("quota_usage")
    .select("used")
    .where("workspace_id", "=", workspaceId)
    .where("day", "=", day)
    .where("engine", "=", engine)
    .executeTakeFirst();
  return row?.used ?? 0;
}

export async function remaining(
  workspace: Pick<Workspace, "id" | "daily_quota">,
  engine: Engine = Engine.GOOGLE,
): Promise<number> {
  return Math.max(0, workspace.daily_quota - (await getUsage(workspace.id, engine)));
}

/**
 * Zwieksza licznik zuzycia i zwraca nowa wartosc.
 *
 * ON DUPLICATE KEY UPDATE zamiast odczytu i zapisu - inaczej dwa rownolegle
 * zgloszenia moglyby odczytac te sama wartosc i jedno z nich by przepadlo,
 * a wtedy panel przekroczylby dzienny limit Google.
 */
export async function consume(
  workspaceId: number,
  amount = 1,
  engine: Engine = Engine.GOOGLE,
): Promise<number> {
  const day = todayIso();
  await sql`
    INSERT INTO quota_usage (workspace_id, day, engine, used)
    VALUES (${workspaceId}, ${day}, ${engine}, ${amount})
    ON DUPLICATE KEY UPDATE used = used + ${amount}
  `.execute(db);
  return getUsage(workspaceId, engine, day);
}

export interface UsagePoint {
  day: string;
  google: number;
  engines: Record<string, number>;
}

export async function usageHistory(workspaceId: number, days = 14): Promise<UsagePoint[]> {
  const start = todayIso(-(days - 1));
  const rows = await db
    .selectFrom("quota_usage")
    .select(["day", "engine", "used"])
    .where("workspace_id", "=", workspaceId)
    .where("day", ">=", start)
    .orderBy("day")
    .execute();

  const buckets = new Map<string, Record<string, number>>();
  for (const day of dayRange(days)) buckets.set(day, {});
  for (const row of rows) {
    const bucket = buckets.get(row.day) ?? {};
    bucket[row.engine] = row.used;
    buckets.set(row.day, bucket);
  }

  return [...buckets.entries()].map(([day, engines]) => ({
    day,
    google: engines[Engine.GOOGLE] ?? 0,
    engines,
  }));
}

export interface SubmissionPoint {
  day: string;
  success: number;
  failed: number;
}

export async function submissionsLastDays(
  workspaceId: number,
  days = 30,
): Promise<SubmissionPoint[]> {
  const rows = await db
    .selectFrom("index_jobs")
    .innerJoin("sites", "sites.id", "index_jobs.site_id")
    .select([
      sql<string>`DATE(index_jobs.created_at)`.as("day"),
      "index_jobs.status as status",
      sql<number>`COUNT(index_jobs.id)`.as("total"),
    ])
    .where("sites.workspace_id", "=", workspaceId)
    .where("index_jobs.created_at", ">=", daysAgo(days - 1))
    .where("index_jobs.job_type", "in", ["URL_UPDATED", "URL_DELETED", "INDEXNOW"])
    .groupBy(["day", "index_jobs.status"])
    .execute();

  const series = new Map<string, SubmissionPoint>();
  for (const day of dayRange(days)) series.set(day, { day, success: 0, failed: 0 });

  for (const row of rows) {
    // DATE() zwraca "RRRR-MM-DD", ale sterownik moze podac obiekt Date.
    const key = typeof row.day === "string" ? row.day : new Date(row.day).toISOString().slice(0, 10);
    const bucket = series.get(key) ?? { day: key, success: 0, failed: 0 };
    if (row.status === JobStatus.SUCCESS) bucket.success += Number(row.total);
    else if (row.status === JobStatus.FAILED) bucket.failed += Number(row.total);
    series.set(key, bucket);
  }

  return [...series.values()].sort((a, b) => a.day.localeCompare(b.day));
}
