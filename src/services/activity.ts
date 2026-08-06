import { db } from "../db";
import type { ActivityEntry } from "../db/types";

export interface LogOptions {
  workspaceId?: number | null;
  level?: "info" | "warning" | "error";
  category?: string;
  details?: unknown;
}

export async function logEvent(message: string, options: LogOptions = {}): Promise<void> {
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
  if (level === "warning" || level === "error") console.warn(line);
  else console.log(line);
}

export function recentActivity(workspaceId: number, limit = 50): Promise<ActivityEntry[]> {
  return db
    .selectFrom("activity_log")
    .selectAll()
    .where((eb) =>
      eb.or([eb("workspace_id", "=", workspaceId), eb("workspace_id", "is", null)]),
    )
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}
