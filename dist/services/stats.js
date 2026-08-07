"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordSiteSnapshot = recordSiteSnapshot;
exports.workspaceIndexingHistory = workspaceIndexingHistory;
exports.recentJobs = recentJobs;
exports.jobTotals = jobTotals;
const kysely_1 = require("kysely");
const db_1 = require("../db");
const types_1 = require("../db/types");
const dates_1 = require("../lib/dates");
async function recordSiteSnapshot(site, submitted = 0, inspected = 0) {
    const day = (0, dates_1.todayIso)();
    const rows = await db_1.db
        .selectFrom("urls")
        .select(["index_status", (0, kysely_1.sql) `COUNT(id)`.as("total")])
        .where("site_id", "=", site.id)
        .where("is_active", "=", true)
        .groupBy("index_status")
        .execute();
    const counts = new Map(rows.map((row) => [row.index_status, Number(row.total)]));
    const totalUrls = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const indexed = counts.get(types_1.IndexStatus.INDEXED) ?? 0;
    const notIndexed = (counts.get(types_1.IndexStatus.NOT_INDEXED) ?? 0) + (counts.get(types_1.IndexStatus.EXCLUDED) ?? 0);
    // Migawka dnia jest jedna, ale wywolan w ciagu dnia wiele - liczniki
    // zgloszen i inspekcji musza sie sumowac, a stany indeksowania nadpisywac.
    await (0, kysely_1.sql) `
    INSERT INTO site_stats (site_id, day, total_urls, indexed, not_indexed, submitted, inspected)
    VALUES (${site.id}, ${day}, ${totalUrls}, ${indexed}, ${notIndexed}, ${submitted}, ${inspected})
    ON DUPLICATE KEY UPDATE
      total_urls = VALUES(total_urls),
      indexed = VALUES(indexed),
      not_indexed = VALUES(not_indexed),
      submitted = submitted + VALUES(submitted),
      inspected = inspected + VALUES(inspected)
  `.execute(db_1.db);
}
async function workspaceIndexingHistory(workspaceId, days = 30) {
    const start = (0, dates_1.todayIso)(-(days - 1));
    const rows = await db_1.db
        .selectFrom("site_stats")
        .innerJoin("sites", "sites.id", "site_stats.site_id")
        .select([
        "site_stats.day as day",
        (0, kysely_1.sql) `SUM(site_stats.indexed)`.as("indexed"),
        (0, kysely_1.sql) `SUM(site_stats.not_indexed)`.as("not_indexed"),
        (0, kysely_1.sql) `SUM(site_stats.total_urls)`.as("total"),
    ])
        .where("sites.workspace_id", "=", workspaceId)
        .where("site_stats.day", ">=", start)
        .groupBy("site_stats.day")
        .orderBy("site_stats.day")
        .execute();
    const known = new Map(rows.map((row) => [
        typeof row.day === "string" ? row.day : new Date(row.day).toISOString().slice(0, 10),
        {
            indexed: Number(row.indexed ?? 0),
            not_indexed: Number(row.not_indexed ?? 0),
            total: Number(row.total ?? 0),
        },
    ]));
    // Dni bez migawki dziedzicza wartosci z poprzedniego dnia. Inaczej wykres
    // spadalby do zera zawsze, gdy panel nie mial nic do zrobienia.
    const series = [];
    let last = { indexed: 0, not_indexed: 0, total: 0 };
    for (const day of (0, dates_1.dayRange)(days)) {
        last = known.get(day) ?? last;
        series.push({ day, ...last });
    }
    return series;
}
function recentJobs(workspaceId, limit = 15) {
    return db_1.db
        .selectFrom("index_jobs")
        .innerJoin("sites", "sites.id", "index_jobs.site_id")
        .selectAll("index_jobs")
        .select("sites.display_name as site_name")
        .where("sites.workspace_id", "=", workspaceId)
        .orderBy("index_jobs.created_at", "desc")
        .limit(limit)
        .execute();
}
async function jobTotals(workspaceId, days = 30) {
    const rows = await db_1.db
        .selectFrom("index_jobs")
        .innerJoin("sites", "sites.id", "index_jobs.site_id")
        .select(["index_jobs.status as status", (0, kysely_1.sql) `COUNT(index_jobs.id)`.as("total")])
        .where("sites.workspace_id", "=", workspaceId)
        .where("index_jobs.created_at", ">=", (0, dates_1.daysAgo)(days))
        .groupBy("index_jobs.status")
        .execute();
    const totals = Object.fromEntries(Object.values(types_1.JobStatus).map((status) => [status, 0]));
    for (const row of rows)
        totals[row.status] = Number(row.total);
    totals["all"] = Object.values(types_1.JobStatus).reduce((sum, s) => sum + (totals[s] ?? 0), 0);
    return totals;
}
//# sourceMappingURL=stats.js.map