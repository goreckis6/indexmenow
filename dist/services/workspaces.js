"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugify = slugify;
exports.createWorkspace = createWorkspace;
exports.createDefaultWorkspace = createDefaultWorkspace;
exports.listWorkspaces = listWorkspaces;
exports.getWorkspace = getWorkspace;
const config_1 = require("../config");
const db_1 = require("../db");
function slugify(value) {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "workspace";
}
async function createWorkspace(userId, name) {
    const baseSlug = slugify(name);
    let slug = baseSlug;
    let counter = 2;
    // Slug trafia do adresow URL, wiec musi byc unikalny w calej instalacji.
    while (await db_1.db.selectFrom("workspaces").select("id").where("slug", "=", slug).executeTakeFirst()) {
        slug = `${baseSlug}-${counter}`;
        counter += 1;
    }
    const result = await db_1.db
        .insertInto("workspaces")
        .values({
        user_id: userId,
        name: name.trim().slice(0, 120) || "Moj workspace",
        slug,
        daily_quota: config_1.config.defaultDailyQuota,
    })
        .executeTakeFirst();
    const workspace = await db_1.db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", Number(result.insertId))
        .executeTakeFirstOrThrow();
    return workspace;
}
function createDefaultWorkspace(user) {
    const label = (user.name || user.email.split("@")[0] || "").trim();
    return createWorkspace(user.id, `Workspace ${label}`.slice(0, 120));
}
function listWorkspaces(userId) {
    return db_1.db
        .selectFrom("workspaces")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("id")
        .execute();
}
function getWorkspace(workspaceId, userId) {
    return db_1.db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", workspaceId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
}
//# sourceMappingURL=workspaces.js.map