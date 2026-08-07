"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUsage = getUsage;
exports.remaining = remaining;
exports.consume = consume;
exports.usageHistory = usageHistory;
exports.submissionsLastDays = submissionsLastDays;
const kysely_1 = require("kysely");
const db_1 = require("../db");
const types_1 = require("../db/types");
const dates_1 = require("../lib/dates");
async function getUsage(workspaceId, engine = types_1.Engine.GOOGLE, day = (0, dates_1.todayIso)()) {
    const row = await db_1.db
        .selectFrom("quota_usage")
        .select("used")
        .where("workspace_id", "=", workspaceId)
        .where("day", "=", day)
        .where("engine", "=", engine)
        .executeTakeFirst();
    return row?.used ?? 0;
}
async function remaining(workspace, engine = types_1.Engine.GOOGLE) {
    return Math.max(0, workspace.daily_quota - (await getUsage(workspace.id, engine)));
}
/**
 * Zwieksza licznik zuzycia i zwraca nowa wartosc.
 *
 * ON DUPLICATE KEY UPDATE zamiast odczytu i zapisu - inaczej dwa rownolegle
 * zgloszenia moglyby odczytac te sama wartosc i jedno z nich by przepadlo,
 * a wtedy panel przekroczylby dzienny limit Google.
 */
async function consume(workspaceId, amount = 1, engine = types_1.Engine.GOOGLE) {
    const day = (0, dates_1.todayIso)();
    await (0, kysely_1.sql) `
    INSERT INTO quota_usage (workspace_id, day, engine, used)
    VALUES (${workspaceId}, ${day}, ${engine}, ${amount})
    ON DUPLICATE KEY UPDATE used = used + ${amount}
  `.execute(db_1.db);
    return getUsage(workspaceId, engine, day);
}
async function usageHistory(workspaceId, days = 14) {
    const start = (0, dates_1.todayIso)(-(days - 1));
    const rows = await db_1.db
        .selectFrom("quota_usage")
        .select(["day", "engine", "used"])
        .where("workspace_id", "=", workspaceId)
        .where("day", ">=", start)
        .orderBy("day")
        .execute();
    const buckets = new Map();
    for (const day of (0, dates_1.dayRange)(days))
        buckets.set(day, {});
    for (const row of rows) {
        const bucket = buckets.get(row.day) ?? {};
        bucket[row.engine] = row.used;
        buckets.set(row.day, bucket);
    }
    return [...buckets.entries()].map(([day, engines]) => ({
        day,
        google: engines[types_1.Engine.GOOGLE] ?? 0,
        engines,
    }));
}
async function submissionsLastDays(workspaceId, days = 30) {
    const rows = await db_1.db
        .selectFrom("index_jobs")
        .innerJoin("sites", "sites.id", "index_jobs.site_id")
        .select([
        (0, kysely_1.sql) `DATE(index_jobs.created_at)`.as("day"),
        "index_jobs.status as status",
        (0, kysely_1.sql) `COUNT(index_jobs.id)`.as("total"),
    ])
        .where("sites.workspace_id", "=", workspaceId)
        .where("index_jobs.created_at", ">=", (0, dates_1.daysAgo)(days - 1))
        .where("index_jobs.job_type", "in", ["URL_UPDATED", "URL_DELETED", "INDEXNOW"])
        .groupBy(["day", "index_jobs.status"])
        .execute();
    const series = new Map();
    for (const day of (0, dates_1.dayRange)(days))
        series.set(day, { day, success: 0, failed: 0 });
    for (const row of rows) {
        // DATE() zwraca "RRRR-MM-DD", ale sterownik moze podac obiekt Date.
        const key = typeof row.day === "string" ? row.day : new Date(row.day).toISOString().slice(0, 10);
        const bucket = series.get(key) ?? { day: key, success: 0, failed: 0 };
        if (row.status === types_1.JobStatus.SUCCESS)
            bucket.success += Number(row.total);
        else if (row.status === types_1.JobStatus.FAILED)
            bucket.failed += Number(row.total);
        series.set(key, bucket);
    }
    return [...series.values()].sort((a, b) => a.day.localeCompare(b.day));
}
//# sourceMappingURL=quota.js.map