"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.propertyToHomeUrl = propertyToHomeUrl;
exports.propertyToDisplayName = propertyToDisplayName;
exports.normalizeProperty = normalizeProperty;
exports.importSitesFromGsc = importSitesFromGsc;
exports.createSite = createSite;
exports.verifySiteAccess = verifySiteAccess;
exports.listSites = listSites;
exports.getSite = getSite;
exports.deleteSite = deleteSite;
const db_1 = require("../db");
const gsc = __importStar(require("../google/searchConsole"));
const oauth_1 = require("../google/oauth");
const crypto_1 = require("../lib/crypto");
const activity_1 = require("./activity");
function propertyToHomeUrl(propertyUrl) {
    if (propertyUrl.startsWith("sc-domain:")) {
        return `https://${propertyUrl.slice("sc-domain:".length)}/`;
    }
    return propertyUrl.endsWith("/") ? propertyUrl : `${propertyUrl}/`;
}
function propertyToDisplayName(propertyUrl) {
    if (propertyUrl.startsWith("sc-domain:"))
        return propertyUrl.slice("sc-domain:".length);
    try {
        const parsed = new URL(propertyUrl);
        const path = parsed.pathname.replace(/\/+$/, "");
        return path ? `${parsed.host}${path}` : parsed.host;
    }
    catch {
        return propertyUrl;
    }
}
function normalizeProperty(raw) {
    const value = raw.trim();
    if (value.startsWith("sc-domain:")) {
        const domain = value.slice("sc-domain:".length).trim().toLowerCase().replace(/^www\./, "");
        return `sc-domain:${domain}`;
    }
    const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
        const parsed = new URL(withScheme);
        const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
        return `${parsed.protocol}//${parsed.host}${path}`;
    }
    catch {
        return withScheme;
    }
}
/** Zaciaga wszystkie wlasciwosci Search Console, do ktorych uzytkownik ma dostep. */
async function importSitesFromGsc(userId, workspace) {
    const token = await (0, oauth_1.getAccessToken)(userId);
    const entries = await gsc.listSites(token);
    const result = { created: 0, updated: 0, skipped: 0, total: entries.length };
    for (const entry of entries) {
        const propertyUrl = entry.siteUrl;
        const permission = entry.permissionLevel ?? "";
        if (!propertyUrl)
            continue;
        // Bez weryfikacji wlasciwosci Search Console nie pozwoli nic zrobic.
        if (permission === "siteUnverifiedUser") {
            result.skipped += 1;
            continue;
        }
        const existing = await db_1.db
            .selectFrom("sites")
            .select("id")
            .where("workspace_id", "=", workspace.id)
            .where("property_url", "=", propertyUrl)
            .executeTakeFirst();
        if (existing) {
            await db_1.db
                .updateTable("sites")
                .set({ permission_level: permission, home_url: propertyToHomeUrl(propertyUrl) })
                .where("id", "=", existing.id)
                .execute();
            result.updated += 1;
        }
        else {
            await db_1.db
                .insertInto("sites")
                .values({
                workspace_id: workspace.id,
                property_url: propertyUrl,
                display_name: propertyToDisplayName(propertyUrl),
                home_url: propertyToHomeUrl(propertyUrl),
                permission_level: permission,
                indexnow_key: (0, crypto_1.generateIndexNowKey)(),
            })
                .execute();
            result.created += 1;
        }
    }
    await (0, activity_1.logEvent)(`Zaimportowano strony z Search Console: ${result.created} nowych, ${result.updated} zaktualizowanych.`, { workspaceId: workspace.id, category: "sites", details: result });
    return result;
}
async function createSite(workspaceId, propertyUrl) {
    const normalized = normalizeProperty(propertyUrl);
    const existing = await db_1.db
        .selectFrom("sites")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("property_url", "=", normalized)
        .executeTakeFirst();
    if (existing)
        return existing;
    const inserted = await db_1.db
        .insertInto("sites")
        .values({
        workspace_id: workspaceId,
        property_url: normalized,
        display_name: propertyToDisplayName(normalized),
        home_url: propertyToHomeUrl(normalized),
        permission_level: "manual",
        indexnow_key: (0, crypto_1.generateIndexNowKey)(),
    })
        .executeTakeFirst();
    return db_1.db
        .selectFrom("sites")
        .selectAll()
        .where("id", "=", Number(inserted.insertId))
        .executeTakeFirstOrThrow();
}
/** Potwierdza, ze zalogowane konto nadal ma dostep do wlasciwosci. */
async function verifySiteAccess(userId, site) {
    const token = await (0, oauth_1.getAccessToken)(userId);
    const entry = await gsc.getSite(token, site.property_url);
    if (entry.permissionLevel) {
        await db_1.db
            .updateTable("sites")
            .set({ permission_level: entry.permissionLevel })
            .where("id", "=", site.id)
            .execute();
    }
    return entry;
}
function listSites(workspaceId) {
    return db_1.db
        .selectFrom("sites")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("priority", "desc")
        .orderBy("display_name")
        .execute();
}
function getSite(siteId, workspaceId) {
    return db_1.db
        .selectFrom("sites")
        .selectAll()
        .where("id", "=", siteId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
}
async function deleteSite(siteId, workspaceId) {
    await db_1.db.deleteFrom("sites").where("id", "=", siteId).where("workspace_id", "=", workspaceId).execute();
}
//# sourceMappingURL=sites.js.map