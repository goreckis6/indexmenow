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
exports.toolsRouter = void 0;
const express_1 = require("express");
const db_1 = require("../db");
const types_1 = require("../db/types");
const crypto_1 = require("../lib/crypto");
const auth_1 = require("../middleware/auth");
const indexer = __importStar(require("../services/indexer"));
const seoTools_1 = require("../services/seoTools");
const sitemapParser_1 = require("../services/sitemapParser");
const sites_1 = require("../services/sites");
const urls_1 = require("../services/urls");
const templating_1 = require("../templating");
const auth_2 = require("./auth");
exports.toolsRouter = (0, express_1.Router)();
exports.toolsRouter.use(...auth_2.panelAuth);
exports.toolsRouter.get("/", (0, auth_1.asyncHandler)(async (req, res) => {
    res.render("tools.html", (0, templating_1.baseContext)(req, {
        user: req.user,
        workspace: req.workspace,
        sites: await (0, sites_1.listSites)(req.workspace.id),
        active_page: "tools",
        tool: typeof req.query.tool === "string" ? req.query.tool : "instant",
    }));
}));
exports.toolsRouter.post("/instant", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.body.site_id));
    const candidates = (0, urls_1.parseUrlBlob)(String(req.body.urls_blob ?? ""));
    if (candidates.length === 0) {
        (0, auth_1.flash)(req, "Nie podano poprawnych adresow URL.", "error");
        return res.redirect(303, "/tools?tool=instant");
    }
    const jobType = req.body.notification_type === "URL_DELETED" ? types_1.JobType.URL_DELETED : types_1.JobType.URL_UPDATED;
    const results = { success: 0, failed: 0, messages: [] };
    const ctx = {
        userId: req.user.id,
        userEmail: req.user.email,
        workspace: req.workspace,
    };
    for (const url of candidates.slice(0, 50)) {
        let page = await db_1.db
            .selectFrom("urls")
            .selectAll()
            .where("site_id", "=", site.id)
            .where("url_hash", "=", (0, crypto_1.sha256)(url))
            .executeTakeFirst();
        if (!page) {
            const inserted = await db_1.db
                .insertInto("urls")
                .values({
                site_id: site.id,
                url: url.slice(0, 2048),
                url_hash: (0, crypto_1.sha256)(url),
                source: "manual",
            })
                .executeTakeFirst();
            page = await db_1.db
                .selectFrom("urls")
                .selectAll()
                .where("id", "=", Number(inserted.insertId))
                .executeTakeFirstOrThrow();
        }
        const job = await indexer.submitSingle(ctx, site, page, url, jobType, "manual");
        if (job.status === types_1.JobStatus.SUCCESS)
            results.success += 1;
        else {
            results.failed += 1;
            if (job.message)
                results.messages.push(`${url}: ${job.message}`);
        }
    }
    if (results.success) {
        (0, auth_1.flash)(req, `Zgloszono ${results.success} URL-i do Google.`, "success");
    }
    for (const message of results.messages.slice(0, 3))
        (0, auth_1.flash)(req, message, "error");
    res.redirect(303, "/tools?tool=instant");
}));
exports.toolsRouter.post("/indexnow", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.body.site_id));
    const candidates = (0, urls_1.parseUrlBlob)(String(req.body.urls_blob ?? ""));
    if (candidates.length === 0) {
        (0, auth_1.flash)(req, "Nie podano poprawnych adresow URL.", "error");
        return res.redirect(303, "/tools?tool=indexnow");
    }
    const result = await indexer.submitIndexNow(site, candidates);
    (0, auth_1.flash)(req, `IndexNow: ${result.message}`, result.ok ? "success" : "error");
    res.redirect(303, "/tools?tool=indexnow");
}));
exports.toolsRouter.get("/preview", (0, auth_1.asyncHandler)(async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    let meta = null;
    if (url) {
        const normalized = (0, urls_1.normalizeUrl)(url);
        meta = normalized
            ? await (0, seoTools_1.fetchPageMeta)(normalized)
            : { url, error: "Nieprawidlowy URL." };
    }
    res.render("tools.html", (0, templating_1.baseContext)(req, {
        user: req.user,
        workspace: req.workspace,
        sites: await (0, sites_1.listSites)(req.workspace.id),
        meta,
        preview_url: url,
        tool: "preview",
        active_page: "tools",
    }));
}));
exports.toolsRouter.get("/sitemap", (0, auth_1.asyncHandler)(async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    let result = null;
    if (url) {
        const normalized = (0, urls_1.normalizeUrl)(url);
        if (normalized) {
            const crawled = await (0, sitemapParser_1.crawlSitemap)(normalized);
            result = {
                source: crawled.source,
                is_index: crawled.isIndex,
                error: crawled.error,
                child_sitemaps: crawled.childSitemaps,
                count: crawled.entries.length,
                entries: crawled.entries.slice(0, 500),
            };
        }
        else {
            result = { error: "Nieprawidlowy URL." };
        }
    }
    res.render("tools.html", (0, templating_1.baseContext)(req, {
        user: req.user,
        workspace: req.workspace,
        sites: await (0, sites_1.listSites)(req.workspace.id),
        sitemap_result: result,
        sitemap_url: url,
        tool: "sitemap",
        active_page: "tools",
    }));
}));
//# sourceMappingURL=tools.js.map