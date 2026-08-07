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
exports.urlsRouter = void 0;
const express_1 = require("express");
const kysely_1 = require("kysely");
const db_1 = require("../db");
const types_1 = require("../db/types");
const auth_1 = require("../middleware/auth");
const crypto_1 = require("../lib/crypto");
const scheduler_1 = require("../services/scheduler");
const sites_1 = require("../services/sites");
const sitemapParser_1 = require("../services/sitemapParser");
const tasks = __importStar(require("../services/tasks"));
const urlService = __importStar(require("../services/urls"));
const templating_1 = require("../templating");
const auth_2 = require("./auth");
exports.urlsRouter = (0, express_1.Router)();
exports.urlsRouter.use(...auth_2.panelAuth);
const PER_PAGE = 100;
function formBool(value) {
    return value === "on" || value === "true" || value === "1" || value === true;
}
exports.urlsRouter.get("/", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const siteId = Number(req.query.site_id) || 0;
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    let query = db_1.db
        .selectFrom("urls")
        .innerJoin("sites", "sites.id", "urls.site_id")
        .where("sites.workspace_id", "=", workspace.id);
    if (siteId)
        query = query.where("urls.site_id", "=", siteId);
    if (status)
        query = query.where("urls.index_status", "=", status);
    if (q)
        query = query.where("urls.url", "like", `%${q}%`);
    const totalRow = await query
        .select((0, kysely_1.sql) `COUNT(urls.id)`.as("total"))
        .executeTakeFirst();
    const total = Number(totalRow?.total ?? 0);
    const rows = await query
        .selectAll("urls")
        .orderBy((0, kysely_1.sql) `urls.last_checked_at IS NULL`, "desc")
        .orderBy("urls.id", "desc")
        .offset((page - 1) * PER_PAGE)
        .limit(PER_PAGE)
        .execute();
    const sites = await (0, sites_1.listSites)(workspace.id);
    const siteMap = Object.fromEntries(sites.map((s) => [s.id, s]));
    res.render("urls.html", (0, templating_1.baseContext)(req, {
        user: req.user,
        workspace,
        rows,
        sites,
        site_map: siteMap,
        total,
        page,
        pages: Math.max(1, Math.ceil(total / PER_PAGE)),
        filter_site: siteId,
        filter_status: status,
        query: q,
        statuses: Object.values(types_1.IndexStatus),
        stats: await urlService.workspaceUrlStats(workspace.id),
        active_page: "urls",
    }));
}));
exports.urlsRouter.post("/add", (0, auth_1.asyncHandler)(async (req, res) => {
    const siteId = Number(req.body.site_id);
    const site = await (0, auth_1.requireSite)(req, siteId);
    let blob = String(req.body.urls_blob ?? "");
    const file = req.file;
    if (file?.buffer) {
        try {
            blob += `\n${file.buffer.toString("utf8")}`;
        }
        catch {
            (0, auth_1.flash)(req, "Nie udalo sie odczytac pliku.", "error");
        }
    }
    const candidates = urlService.parseUrlBlob(blob);
    if (candidates.length === 0) {
        (0, auth_1.flash)(req, "Nie znaleziono zadnego poprawnego adresu URL.", "error");
        return res.redirect(303, `/sites/${siteId}?tab=urls`);
    }
    const valid = candidates.filter((u) => (0, sitemapParser_1.urlBelongsToSite)(u, site.home_url, (0, types_1.isDomainProperty)(site)));
    const rejected = candidates.length - valid.length;
    const priority = Number(req.body.priority) || 0;
    const result = await urlService.addUrls(site, valid, "manual", new Map(), priority);
    let message = `Dodano ${result.added} URL-i (${result.duplicates} juz istnialo).`;
    if (rejected) {
        message += ` Odrzucono ${rejected} adresow spoza domeny ${site.display_name}.`;
    }
    (0, auth_1.flash)(req, message, result.added ? "success" : "warning");
    if (formBool(req.body.submit_now) && result.added) {
        const hashes = valid.map((u) => (0, crypto_1.sha256)(u));
        const newIds = (await db_1.db
            .selectFrom("urls")
            .select("id")
            .where("site_id", "=", site.id)
            .where("url_hash", "in", hashes)
            .execute()).map((r) => r.id);
        (0, scheduler_1.runInBackground)(`site:${site.id}`, () => tasks.taskSubmitUrls(site.id, newIds));
        (0, auth_1.flash)(req, "Zgloszenie do Google uruchomione w tle.", "success");
    }
    res.redirect(303, `/sites/${siteId}?tab=urls`);
}));
exports.urlsRouter.post("/action", (0, auth_1.asyncHandler)(async (req, res) => {
    const action = String(req.body.action ?? "");
    const redirectTo = String(req.body.redirect_to ?? "/urls");
    const rawIds = req.body.url_ids;
    const urlIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [])
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0);
    if (urlIds.length === 0) {
        (0, auth_1.flash)(req, "Nie zaznaczono zadnego URL-a.", "warning");
        return res.redirect(303, redirectTo);
    }
    const pages = await db_1.db
        .selectFrom("urls")
        .innerJoin("sites", "sites.id", "urls.site_id")
        .selectAll("urls")
        .where("urls.id", "in", urlIds)
        .where("sites.workspace_id", "=", req.workspace.id)
        .execute();
    if (pages.length === 0) {
        (0, auth_1.flash)(req, "Nie znaleziono wskazanych URL-i.", "error");
        return res.redirect(303, redirectTo);
    }
    const bySite = new Map();
    for (const page of pages) {
        const list = bySite.get(page.site_id) ?? [];
        list.push(page.id);
        bySite.set(page.site_id, list);
    }
    if (action === "submit") {
        for (const [siteId, ids] of bySite) {
            (0, scheduler_1.runInBackground)(`site:${siteId}`, () => tasks.taskSubmitUrls(siteId, ids));
        }
        (0, auth_1.flash)(req, `Zgloszono ${pages.length} URL-i do indeksowania (w tle).`, "success");
    }
    else if (action === "inspect") {
        for (const [siteId, ids] of bySite) {
            (0, scheduler_1.runInBackground)(`site:${siteId}`, () => tasks.taskInspectUrls(siteId, ids));
        }
        (0, auth_1.flash)(req, `Uruchomiono inspekcje ${pages.length} URL-i (w tle).`, "success");
    }
    else if (action === "delete") {
        await db_1.db
            .deleteFrom("urls")
            .where("id", "in", pages.map((p) => p.id))
            .execute();
        (0, auth_1.flash)(req, `Usunieto ${pages.length} URL-i.`, "success");
    }
    else if (action === "priority") {
        await db_1.db
            .updateTable("urls")
            .set({ priority: 10 })
            .where("id", "in", pages.map((p) => p.id))
            .execute();
        (0, auth_1.flash)(req, `Ustawiono wysoki priorytet dla ${pages.length} URL-i.`, "success");
    }
    else if (action === "reset") {
        await db_1.db
            .updateTable("urls")
            .set({ index_status: types_1.IndexStatus.UNKNOWN, last_checked_at: null })
            .where("id", "in", pages.map((p) => p.id))
            .execute();
        (0, auth_1.flash)(req, `Zresetowano status ${pages.length} URL-i.`, "success");
    }
    else {
        (0, auth_1.flash)(req, `Nieznana akcja: ${action}`, "error");
    }
    res.redirect(303, redirectTo);
}));
exports.urlsRouter.get("/export.csv", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const siteId = Number(req.query.site_id) || 0;
    const status = typeof req.query.status === "string" ? req.query.status : "";
    let query = db_1.db
        .selectFrom("urls")
        .innerJoin("sites", "sites.id", "urls.site_id")
        .select([
        "sites.display_name as site_name",
        "urls.url",
        "urls.index_status",
        "urls.coverage_state",
        "urls.verdict",
        "urls.last_checked_at",
        "urls.last_submitted_at",
        "urls.submit_count",
        "urls.source",
    ])
        .where("sites.workspace_id", "=", workspace.id);
    if (siteId)
        query = query.where("urls.site_id", "=", siteId);
    if (status)
        query = query.where("urls.index_status", "=", status);
    const rows = await query.execute();
    const header = "strona;url;status;coverage_state;verdict;ostatnia_inspekcja;ostatnie_zgloszenie;liczba_zgloszen;zrodlo\n";
    const body = rows
        .map((row) => [
        row.site_name,
        row.url,
        row.index_status,
        row.coverage_state || "",
        row.verdict || "",
        row.last_checked_at?.toISOString() ?? "",
        row.last_submitted_at?.toISOString() ?? "",
        row.submit_count,
        row.source,
    ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(";"))
        .join("\n");
    res.setHeader("Content-Disposition", 'attachment; filename="indexmenow-urls.csv"');
    res.type("text/csv; charset=utf-8").send(header + body);
}));
//# sourceMappingURL=urls.js.map