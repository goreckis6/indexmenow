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
exports.taskScanSitemaps = taskScanSitemaps;
exports.taskInspect = taskInspect;
exports.taskRunPipeline = taskRunPipeline;
exports.taskSubmitUrls = taskSubmitUrls;
exports.taskInspectUrls = taskInspectUrls;
exports.taskRunAllSites = taskRunAllSites;
const db_1 = require("../db");
const activity_1 = require("./activity");
const indexer = __importStar(require("./indexer"));
const sitemaps = __importStar(require("./sitemaps"));
async function loadSiteContext(siteId) {
    const site = await db_1.db.selectFrom("sites").selectAll().where("id", "=", siteId).executeTakeFirst();
    if (!site)
        throw new Error(`Site ${siteId} nie istnieje`);
    const workspace = await db_1.db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", site.workspace_id)
        .executeTakeFirstOrThrow();
    const user = await db_1.db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", workspace.user_id)
        .executeTakeFirstOrThrow();
    return { site, workspace, user };
}
async function taskScanSitemaps(siteId) {
    const { site } = await loadSiteContext(siteId);
    await sitemaps.scanAllSitemaps(site);
}
async function taskInspect(siteId, limit) {
    const { site, user } = await loadSiteContext(siteId);
    const summary = await indexer.inspectBatch(user.id, site, limit, "manual");
    await (0, activity_1.logEvent)(`Inspekcja ${site.display_name}: sprawdzono ${summary.checked} URL-i (${summary.indexed} zaindeksowanych).`, { workspaceId: site.workspace_id, category: "inspection", details: summary });
}
async function taskRunPipeline(siteId, scan = true) {
    const { site, workspace, user } = await loadSiteContext(siteId);
    await indexer.runSitePipeline(user.id, user.email, workspace, site, "manual", scan);
}
async function taskSubmitUrls(siteId, urlIds) {
    const { site, workspace, user } = await loadSiteContext(siteId);
    let pages = [];
    if (urlIds.length > 0) {
        pages = await db_1.db
            .selectFrom("urls")
            .selectAll()
            .where("site_id", "=", site.id)
            .where("id", "in", urlIds)
            .execute();
    }
    const summary = await indexer.submitBatch(user.id, user.email, workspace, site, pages);
    await (0, activity_1.logEvent)(`Zgloszono ${summary.submitted} URL-i dla ${site.display_name}.`, {
        workspaceId: site.workspace_id,
        category: "indexing",
        details: summary,
    });
}
async function taskInspectUrls(siteId, urlIds) {
    const { site, user } = await loadSiteContext(siteId);
    if (urlIds.length === 0)
        return;
    const pages = await db_1.db
        .selectFrom("urls")
        .selectAll()
        .where("site_id", "=", site.id)
        .where("id", "in", urlIds)
        .execute();
    for (const page of pages) {
        await indexer.inspectSingle(user.id, site, page, "manual");
    }
}
async function taskRunAllSites(workspaceId) {
    const workspace = await db_1.db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", workspaceId)
        .executeTakeFirst();
    if (!workspace)
        return;
    const user = await db_1.db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", workspace.user_id)
        .executeTakeFirst();
    if (!user)
        return;
    const sites = await db_1.db
        .selectFrom("sites")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("is_active", "=", true)
        .execute();
    for (const site of sites) {
        try {
            await indexer.runSitePipeline(user.id, user.email, workspace, site, "manual");
        }
        catch (error) {
            console.error(`Pipeline nie powiodl sie dla strony ${site.id}`, error);
        }
    }
}
//# sourceMappingURL=tasks.js.map