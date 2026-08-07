import { config } from "../config.js";
import { db } from "../db/index.js";
import type { User, Workspace } from "../db/types.js";

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "workspace";
}

export async function createWorkspace(userId: number, name: string): Promise<Workspace> {
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let counter = 2;
  // Slug trafia do adresow URL, wiec musi byc unikalny w calej instalacji.
  while (
    await db.selectFrom("workspaces").select("id").where("slug", "=", slug).executeTakeFirst()
  ) {
    slug = `${baseSlug}-${counter}`;
    counter += 1;
  }

  const result = await db
    .insertInto("workspaces")
    .values({
      user_id: userId,
      name: name.trim().slice(0, 120) || "Moj workspace",
      slug,
      daily_quota: config.defaultDailyQuota,
    })
    .executeTakeFirst();

  const workspace = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", Number(result.insertId))
    .executeTakeFirstOrThrow();
  return workspace;
}

export function createDefaultWorkspace(user: Pick<User, "id" | "name" | "email">): Promise<Workspace> {
  const label = (user.name || user.email.split("@")[0] || "").trim();
  return createWorkspace(user.id, `Workspace ${label}`.slice(0, 120));
}

export function listWorkspaces(userId: number): Promise<Workspace[]> {
  return db
    .selectFrom("workspaces")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("id")
    .execute();
}

export function getWorkspace(workspaceId: number, userId: number): Promise<Workspace | undefined> {
  return db
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", workspaceId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}
