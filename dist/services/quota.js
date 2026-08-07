import { sql } from "kysely";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { Engine, JobStatus } from "../db/types.js";
import { dayRange, daysAgo, todayIso } from "../lib/dates.js";
/** Bazowy limit OAuth (jeden projekt Google Cloud) — bez kont SA. */
export const OAUTH_DAILY_BASELINE = 200;
export async function getUsage(workspaceId, engine = Engine.GOOGLE, day = todayIso()) {
    const row = await db
        .selectFrom("quota_usage")
        .select("used")
        .where("workspace_id", "=", workspaceId)
        .where("day", "=", day)
        .where("engine", "=", engine)
        .executeTakeFirst();
    return row?.used ?? 0;
}
/** Suma daily_quota aktywnych kont serwisowych w workspace. */
export async function serviceAccountCapacity(workspaceId) {
    const row = await db
        .selectFrom("service_accounts")
        .select((eb) => eb.fn.sum("daily_quota").as("total"))
        .where("workspace_id", "=", workspaceId)
        .where("is_active", "=", true)
        .executeTakeFirst();
    return Number(row?.total ?? 0);
}
/**
 * Przelicza limit workspace = OAuth 200 + suma aktywnych SA.
 * Podnosi tez daily_limit stron, ktore jeszcze siedza na starym domyslnym 50.
 */
export async function syncWorkspaceQuota(workspaceId) {
    const saCapacity = await serviceAccountCapacity(workspaceId);
    const dailyQuota = OAUTH_DAILY_BASELINE + saCapacity;
    await db
        .updateTable("workspaces")
        .set({ daily_quota: dailyQuota })
        .where("id", "=", workspaceId)
        .execute();
    // Stary domysl 50 blokowal przebieg mimo wiekszej pojemnosci workspace.
    if (dailyQuota > 50) {
        await db
            .updateTable("sites")
            .set({ daily_limit: Math.min(dailyQuota, 200) })
            .where("workspace_id", "=", workspaceId)
            .where("daily_limit", "<=", 50)
            .execute();
    }
    return {
        dailyQuota,
        serviceAccounts: saCapacity,
        oauthBaseline: OAUTH_DAILY_BASELINE,
    };
}
export async function remaining(workspace, engine = Engine.GOOGLE) {
    return Math.max(0, workspace.daily_quota - (await getUsage(workspace.id, engine)));
}
/**
 * Zwieksza licznik zuzycia i zwraca nowa wartosc.
 *
 * ON DUPLICATE KEY UPDATE zamiast odczytu i zapisu - inaczej dwa rownolegle
 * zgloszenia moglyby odczytac te sama wartosc i jedno z nich by przepadlo,
 * a wtedy panel przekroczylby dzienny limit Google.
 */
export async function consume(workspaceId, amount = 1, engine = Engine.GOOGLE) {
    const day = todayIso();
    await sql `
    INSERT INTO quota_usage (workspace_id, day, engine, used)
    VALUES (${workspaceId}, ${day}, ${engine}, ${amount})
    ON DUPLICATE KEY UPDATE used = used + ${amount}
  `.execute(db);
    return getUsage(workspaceId, engine, day);
}
export async function usageHistory(workspaceId, days = 14) {
    const start = todayIso(-(days - 1));
    const rows = await db
        .selectFrom("quota_usage")
        .select(["day", "engine", "used"])
        .where("workspace_id", "=", workspaceId)
        .where("day", ">=", start)
        .orderBy("day")
        .execute();
    const buckets = new Map();
    for (const day of dayRange(days))
        buckets.set(day, {});
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
export async function submissionsLastDays(workspaceId, days = 30) {
    const rows = await db
        .selectFrom("index_jobs")
        .innerJoin("sites", "sites.id", "index_jobs.site_id")
        .select([
        sql `DATE(index_jobs.created_at)`.as("day"),
        "index_jobs.status as status",
        sql `COUNT(index_jobs.id)`.as("total"),
    ])
        .where("sites.workspace_id", "=", workspaceId)
        .where("index_jobs.created_at", ">=", daysAgo(days - 1))
        .where("index_jobs.job_type", "in", ["URL_UPDATED", "URL_DELETED", "INDEXNOW"])
        .groupBy(["day", "index_jobs.status"])
        .execute();
    const series = new Map();
    for (const day of dayRange(days))
        series.set(day, { day, success: 0, failed: 0 });
    for (const row of rows) {
        // DATE() zwraca "RRRR-MM-DD", ale sterownik moze podac obiekt Date.
        const key = typeof row.day === "string" ? row.day : new Date(row.day).toISOString().slice(0, 10);
        const bucket = series.get(key) ?? { day: key, success: 0, failed: 0 };
        if (row.status === JobStatus.SUCCESS)
            bucket.success += Number(row.total);
        else if (row.status === JobStatus.FAILED)
            bucket.failed += Number(row.total);
        series.set(key, bucket);
    }
    return [...series.values()].sort((a, b) => a.day.localeCompare(b.day));
}
/** Domyslny limit nowej strony — nie wiecej niz quota workspace / config. */
export function defaultSiteDailyLimit(workspaceQuota = config.defaultDailyQuota) {
    return Math.min(200, Math.max(50, workspaceQuota));
}
//# sourceMappingURL=quota.js.map