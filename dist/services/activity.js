import { db } from "../db/index.js";
export async function logEvent(message, options = {}) {
    const { workspaceId = null, level = "info", category = "system", details } = options;
    await db
        .insertInto("activity_log")
        .values({
        workspace_id: workspaceId,
        level,
        category,
        message,
        // MySQL oczekuje tekstu w kolumnie JSON, nie obiektu.
        details: details === undefined ? null : JSON.stringify(details),
    })
        .execute();
    const line = `[${category}] ${message}`;
    if (level === "warning" || level === "error")
        console.warn(line);
    else
        console.log(line);
}
export function recentActivity(workspaceId, limit = 50) {
    return db
        .selectFrom("activity_log")
        .selectAll()
        .where((eb) => eb.or([eb("workspace_id", "=", workspaceId), eb("workspace_id", "is", null)]))
        .orderBy("created_at", "desc")
        .limit(limit)
        .execute();
}
//# sourceMappingURL=activity.js.map