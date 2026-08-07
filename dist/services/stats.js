import { sql } from "kysely";
import { db } from "../db/index.js";
import { IndexStatus, JobStatus } from "../db/types.js";
import { dayRange, daysAgo, todayIso } from "../lib/dates.js";
export async function recordSiteSnapshot(site, submitted = 0, inspected = 0) {
    const day = todayIso();
    const rows = await db
        .selectFrom("urls")
        .select(["index_status", sql `COUNT(id)`.as("total")])
        .where("site_id", "=", site.id)
        .where("is_active", "=", true)
        .groupBy("index_status")
        .execute();
    const counts = new Map(rows.map((row) => [row.index_status, Number(row.total)]));
    const totalUrls = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const indexed = counts.get(IndexStatus.INDEXED) ?? 0;
    const notIndexed = (counts.get(IndexStatus.NOT_INDEXED) ?? 0) + (counts.get(IndexStatus.EXCLUDED) ?? 0);
    // Migawka dnia jest jedna, ale wywolan w ciagu dnia wiele - liczniki
    // zgloszen i inspekcji musza sie sumowac, a stany indeksowania nadpisywac.
    await sql `
    INSERT INTO site_stats (site_id, day, total_urls, indexed, not_indexed, submitted, inspected)
    VALUES (${site.id}, ${day}, ${totalUrls}, ${indexed}, ${notIndexed}, ${submitted}, ${inspected})
    ON DUPLICATE KEY UPDATE
      total_urls = VALUES(total_urls),
      indexed = VALUES(indexed),
      not_indexed = VALUES(not_indexed),
      submitted = submitted + VALUES(submitted),
      inspected = inspected + VALUES(inspected)
  `.execute(db);
}
export async function workspaceIndexingHistory(workspaceId, days = 30) {
    const start = todayIso(-(days - 1));
    const rows = await db
        .selectFrom("site_stats")
        .innerJoin("sites", "sites.id", "site_stats.site_id")
        .select([
        "site_stats.day as day",
        sql `SUM(site_stats.indexed)`.as("indexed"),
        sql `SUM(site_stats.not_indexed)`.as("not_indexed"),
        sql `SUM(site_stats.total_urls)`.as("total"),
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
    for (const day of dayRange(days)) {
        last = known.get(day) ?? last;
        series.push({ day, ...last });
    }
    return series;
}
export function recentJobs(workspaceId, limit = 15) {
    return db
        .selectFrom("index_jobs")
        .innerJoin("sites", "sites.id", "index_jobs.site_id")
        .selectAll("index_jobs")
        .select("sites.display_name as site_name")
        .where("sites.workspace_id", "=", workspaceId)
        .orderBy("index_jobs.created_at", "desc")
        .limit(limit)
        .execute();
}
export async function jobTotals(workspaceId, days = 30) {
    const rows = await db
        .selectFrom("index_jobs")
        .innerJoin("sites", "sites.id", "index_jobs.site_id")
        .select(["index_jobs.status as status", sql `COUNT(index_jobs.id)`.as("total")])
        .where("sites.workspace_id", "=", workspaceId)
        .where("index_jobs.created_at", ">=", daysAgo(days))
        .groupBy("index_jobs.status")
        .execute();
    const totals = Object.fromEntries(Object.values(JobStatus).map((status) => [status, 0]));
    for (const row of rows)
        totals[row.status] = Number(row.total);
    totals["all"] = Object.values(JobStatus).reduce((sum, s) => sum + (totals[s] ?? 0), 0);
    return totals;
}
//# sourceMappingURL=stats.js.map