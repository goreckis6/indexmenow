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
exports.sitesRouter = void 0;
const express_1 = require("express");
const db_1 = require("../db");
const types_1 = require("../db/types");
const errors_1 = require("../google/errors");
const indexnow_1 = require("../google/indexnow");
const crypto_1 = require("../lib/crypto");
const auth_1 = require("../middleware/auth");
const quota = __importStar(require("../services/quota"));
const scheduler_1 = require("../services/scheduler");
const sitemapService = __importStar(require("../services/sitemaps"));
const siteService = __importStar(require("../services/sites"));
const stats_1 = require("../services/stats");
const tasks = __importStar(require("../services/tasks"));
const urls_1 = require("../services/urls");
const templating_1 = require("../templating");
const auth_2 = require("./auth");
exports.sitesRouter = (0, express_1.Router)();
exports.sitesRouter.use(...auth_2.panelAuth);
function back(siteId, tab = "") {
    return tab ? `/sites/${siteId}?tab=${tab}` : `/sites/${siteId}`;
}
function formBool(value) {
    if (Array.isArray(value))
        return value.some((v) => formBool(v));
    return value === "on" || value === "true" || value === "1" || value === true;
}
exports.sitesRouter.get("/", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const sites = await siteService.listSites(workspace.id);
    const rows = [];
    for (const site of sites) {
        const stats = await (0, urls_1.siteUrlStats)(site.id);
        const hasSitemap = await db_1.db
            .selectFrom("sitemaps")
            .select("id")
            .where("site_id", "=", site.id)
            .limit(1)
            .executeTakeFirst();
        rows.push({
            site,
            stats,
            sitemaps: Boolean(hasSitemap),
            busy: (0, scheduler_1.isRunning)(`site:${site.id}`),
        });
    }
    res.render("sites.html", (0, templating_1.baseContext)(req, { user: req.user, workspace, rows, active_page: "sites" }));
}));
exports.sitesRouter.post("/import", (0, auth_1.asyncHandler)(async (req, res) => {
    try {
        const result = await siteService.importSitesFromGsc(req.user.id, req.workspace);
        (0, auth_1.flash)(req, `Import zakonczony: ${result.created} nowych, ${result.updated} zaktualizowanych` +
            (result.skipped ? `, ${result.skipped} pominietych (brak weryfikacji).` : "."), "success");
    }
    catch (error) {
        const message = error instanceof errors_1.GoogleApiError ? error.toString() : String(error);
        (0, auth_1.flash)(req, `Nie udalo sie pobrac stron z Search Console: ${message}`, "error");
    }
    res.redirect(303, "/sites");
}));
exports.sitesRouter.post("/add", (0, auth_1.asyncHandler)(async (req, res) => {
    const propertyUrl = String(req.body.property_url ?? "").trim();
    if (!propertyUrl) {
        (0, auth_1.flash)(req, "Podaj adres strony.", "error");
        return res.redirect(303, "/sites");
    }
    const site = await siteService.createSite(req.workspace.id, propertyUrl);
    (0, auth_1.flash)(req, `Dodano strone ${site.display_name}.`, "success");
    res.redirect(303, back(site.id));
}));
exports.sitesRouter.post("/run-all", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const started = (0, scheduler_1.runInBackground)(`workspace:${workspace.id}`, () => tasks.taskRunAllSites(workspace.id));
    (0, auth_1.flash)(req, started ? "Uruchomiono indeksowanie wszystkich stron." : "Indeksowanie juz trwa.", started ? "success" : "warning");
    res.redirect(303, "/sites");
}));
exports.sitesRouter.get("/:siteId", (0, auth_1.asyncHandler)(async (req, res) => {
    const siteId = Number(req.params.siteId);
    const site = await (0, auth_1.requireSite)(req, siteId);
    const perPage = 50;
    const tab = typeof req.query.tab === "string" ? req.query.tab : "overview";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    let query = db_1.db.selectFrom("urls").selectAll().where("site_id", "=", site.id);
    if (status)
        query = query.where("index_status", "=", status);
    if (q)
        query = query.where("url", "like", `%${q}%`);
    const totalRow = await query
        .clearSelect()
        .select((eb) => eb.fn.countAll().as("total"))
        .executeTakeFirst();
    const total = Number(totalRow?.total ?? 0);
    const urls = await query
        .orderBy("index_status")
        .orderBy("id", "desc")
        .offset((page - 1) * perPage)
        .limit(perPage)
        .execute();
    const sitemaps = await sitemapService.listSitemaps(site.id);
    const jobs = await db_1.db
        .selectFrom("index_jobs")
        .selectAll()
        .where("site_id", "=", site.id)
        .orderBy("created_at", "desc")
        .limit(30)
        .execute();
    res.render("site_detail.html", (0, templating_1.baseContext)(req, {
        user: req.user,
        workspace: req.workspace,
        site,
        stats: await (0, urls_1.siteUrlStats)(site.id),
        sitemaps,
        urls,
        total_urls: total,
        page,
        per_page: perPage,
        pages: Math.max(1, Math.ceil(total / perPage)),
        filter_status: status,
        query: q,
        tab,
        jobs,
        history: await (0, stats_1.workspaceIndexingHistory)(req.workspace.id, 30),
        quota_left: await quota.remaining(req.workspace),
        busy: (0, scheduler_1.isRunning)(`site:${site.id}`),
        indexnow_url: (0, indexnow_1.keyFileUrl)(site.home_url, site.indexnow_key || ""),
        active_page: "sites",
    }));
}));
exports.sitesRouter.post("/:siteId/settings", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const displayName = String(req.body.display_name ?? "").trim();
    const dailyLimit = Math.max(0, Math.min(Number(req.body.daily_limit) || 50, 10_000));
    const priority = Math.max(0, Math.min(Number(req.body.priority) || 0, 100));
    const autoIndex = formBool(req.body.auto_index);
    const indexnowEnabled = formBool(req.body.indexnow_enabled);
    const isActive = formBool(req.body.is_active);
    await db_1.db
        .updateTable("sites")
        .set({
        ...(displayName ? { display_name: displayName.slice(0, 255) } : {}),
        daily_limit: dailyLimit,
        priority,
        auto_index: autoIndex,
        indexnow_enabled: indexnowEnabled,
        is_active: isActive,
        ...(indexnowEnabled && !site.indexnow_key
            ? { indexnow_key: (0, crypto_1.generateIndexNowKey)() }
            : {}),
    })
        .where("id", "=", site.id)
        .execute();
    (0, auth_1.flash)(req, "Ustawienia strony zapisane.", "success");
    res.redirect(303, back(site.id, "settings"));
}));
exports.sitesRouter.post("/:siteId/delete", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const name = site.display_name;
    await siteService.deleteSite(site.id, req.workspace.id);
    (0, auth_1.flash)(req, `Usunieto strone ${name} wraz z jej danymi.`, "success");
    res.redirect(303, "/sites");
}));
exports.sitesRouter.post("/:siteId/regenerate-key", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    await db_1.db
        .updateTable("sites")
        .set({ indexnow_key: (0, crypto_1.generateIndexNowKey)() })
        .where("id", "=", site.id)
        .execute();
    (0, auth_1.flash)(req, "Wygenerowano nowy klucz IndexNow. Wgraj nowy plik na serwer.", "warning");
    res.redirect(303, back(site.id, "settings"));
}));
exports.sitesRouter.get("/:siteId/indexnow-key", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const key = site.indexnow_key || "";
    res.setHeader("Content-Disposition", `attachment; filename="${key}.txt"`);
    res.type("text/plain").send(key);
}));
exports.sitesRouter.post("/:siteId/scan", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const started = (0, scheduler_1.runInBackground)(`site:${site.id}`, () => tasks.taskScanSitemaps(site.id));
    (0, auth_1.flash)(req, started ? "Skanowanie sitemap uruchomione w tle." : "Zadanie dla tej strony juz trwa.", started ? "success" : "warning");
    res.redirect(303, back(site.id, "sitemaps"));
}));
exports.sitesRouter.post("/:siteId/inspect", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const limit = Math.max(1, Number(req.body.limit) || 50);
    const started = (0, scheduler_1.runInBackground)(`site:${site.id}`, () => tasks.taskInspect(site.id, limit));
    (0, auth_1.flash)(req, started
        ? `Inspekcja ${limit} URL-i uruchomiona w tle.`
        : "Zadanie dla tej strony juz trwa.", started ? "success" : "warning");
    res.redirect(303, back(site.id, "urls"));
}));
exports.sitesRouter.post("/:siteId/run", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    if ((await quota.remaining(req.workspace)) <= 0) {
        (0, auth_1.flash)(req, "Dzienny limit zgloszen zostal wyczerpany.", "warning");
        return res.redirect(303, back(site.id));
    }
    const scan = formBool(req.body.scan) || req.body.scan === undefined;
    const started = (0, scheduler_1.runInBackground)(`site:${site.id}`, () => tasks.taskRunPipeline(site.id, scan));
    (0, auth_1.flash)(req, started
        ? "Indeksowanie uruchomione: skan sitemap, inspekcja i zgloszenia."
        : "Zadanie dla tej strony juz trwa.", started ? "success" : "warning");
    res.redirect(303, back(site.id));
}));
exports.sitesRouter.post("/:siteId/sitemaps/add", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const path = String(req.body.path ?? "").trim();
    const sitemap = await sitemapService.addSitemap(site, path);
    (0, auth_1.flash)(req, `Dodano sitemape ${sitemap.path}.`, "success");
    if (formBool(req.body.submit_to_google)) {
        const job = await sitemapService.submitToGoogle(req.user.id, site, sitemap);
        (0, auth_1.flash)(req, job.message || "Zgloszono sitemape.", job.status === types_1.JobStatus.SUCCESS ? "success" : "error");
    }
    res.redirect(303, back(site.id, "sitemaps"));
}));
exports.sitesRouter.post("/:siteId/sitemaps/sync", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    try {
        const result = await sitemapService.syncFromGsc(req.user.id, site);
        (0, auth_1.flash)(req, `Zsynchronizowano sitemapy z GSC: ${result.created} nowych, ${result.updated} zaktualizowanych.`, "success");
    }
    catch (error) {
        const message = error instanceof errors_1.GoogleApiError ? error.toString() : String(error);
        (0, auth_1.flash)(req, `Blad synchronizacji sitemap: ${message}`, "error");
    }
    res.redirect(303, back(site.id, "sitemaps"));
}));
exports.sitesRouter.post("/:siteId/sitemaps/discover", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const found = await sitemapService.discoverSitemaps(site);
    (0, auth_1.flash)(req, found.length ? `Znaleziono ${found.length} sitemap.` : "Nie znaleziono zadnej sitemapy.", found.length ? "success" : "warning");
    res.redirect(303, back(site.id, "sitemaps"));
}));
exports.sitesRouter.post("/:siteId/sitemaps/:sitemapId/submit", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const sitemap = await sitemapService.getSitemap(Number(req.params.sitemapId), site.id);
    if (!sitemap) {
        (0, auth_1.flash)(req, "Nie znaleziono sitemapy.", "error");
        return res.redirect(303, back(site.id, "sitemaps"));
    }
    const job = await sitemapService.submitToGoogle(req.user.id, site, sitemap);
    (0, auth_1.flash)(req, job.message || "Zgloszono sitemape.", job.status === types_1.JobStatus.SUCCESS ? "success" : "error");
    res.redirect(303, back(site.id, "sitemaps"));
}));
exports.sitesRouter.post("/:siteId/sitemaps/:sitemapId/scan", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const sitemap = await sitemapService.getSitemap(Number(req.params.sitemapId), site.id);
    if (!sitemap) {
        (0, auth_1.flash)(req, "Nie znaleziono sitemapy.", "error");
        return res.redirect(303, back(site.id, "sitemaps"));
    }
    const result = await sitemapService.scanSitemap(site, sitemap);
    if (result.error)
        (0, auth_1.flash)(req, `Blad skanowania: ${result.error}`, "error");
    else {
        (0, auth_1.flash)(req, `Zaimportowano ${result.added} nowych URL-i (${result.duplicates} juz istnialo).`, "success");
    }
    res.redirect(303, back(site.id, "sitemaps"));
}));
exports.sitesRouter.post("/:siteId/sitemaps/:sitemapId/delete", (0, auth_1.asyncHandler)(async (req, res) => {
    const site = await (0, auth_1.requireSite)(req, Number(req.params.siteId));
    const sitemap = await sitemapService.getSitemap(Number(req.params.sitemapId), site.id);
    if (!sitemap) {
        (0, auth_1.flash)(req, "Nie znaleziono sitemapy.", "error");
        return res.redirect(303, back(site.id, "sitemaps"));
    }
    if (formBool(req.body.from_google)) {
        const job = await sitemapService.deleteFromGoogle(req.user.id, site, sitemap);
        if (job.status !== types_1.JobStatus.SUCCESS)
            (0, auth_1.flash)(req, `Google: ${job.message}`, "warning");
    }
    await sitemapService.deleteSitemap(sitemap.id, site.id);
    (0, auth_1.flash)(req, "Sitemapa usunieta.", "success");
    res.redirect(303, back(site.id, "sitemaps"));
}));
//# sourceMappingURL=sites.js.map