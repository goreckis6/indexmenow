import { Router } from "express";
import { db } from "../db/index.js";
import { IndexStatus, JobStatus } from "../db/types.js";
import { GoogleApiError } from "../google/errors.js";
import { keyFileUrl } from "../google/indexnow.js";
import { generateIndexNowKey } from "../lib/crypto.js";
import { asyncHandler, flash, requireSite } from "../middleware/auth.js";
import * as quota from "../services/quota.js";
import { isRunning, runInBackground } from "../services/scheduler.js";
import * as sitemapService from "../services/sitemaps.js";
import * as siteService from "../services/sites.js";
import { workspaceIndexingHistory } from "../services/stats.js";
import * as tasks from "../services/tasks.js";
import { siteUrlStats } from "../services/urls.js";
import { baseContext } from "../templating.js";
import { panelAuth } from "./auth.js";

export const sitesRouter = Router();
sitesRouter.use(...panelAuth);

function back(siteId: number, tab = ""): string {
  return tab ? `/sites/${siteId}?tab=${tab}` : `/sites/${siteId}`;
}

function formBool(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => formBool(v));
  return value === "on" || value === "true" || value === "1" || value === true;
}

sitesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const sites = await siteService.listSites(workspace.id);
    const rows = [];
    for (const site of sites) {
      const stats = await siteUrlStats(site.id);
      const hasSitemap = await db
        .selectFrom("sitemaps")
        .select("id")
        .where("site_id", "=", site.id)
        .limit(1)
        .executeTakeFirst();
      rows.push({
        site,
        stats,
        sitemaps: Boolean(hasSitemap),
        busy: isRunning(`site:${site.id}`),
      });
    }
    res.render(
      "sites.html",
      baseContext(req, { user: req.user, workspace, rows, active_page: "sites" }),
    );
  }),
);

sitesRouter.post(
  "/import",
  asyncHandler(async (req, res) => {
    try {
      const result = await siteService.importSitesFromGsc(req.user!.id, req.workspace!);
      flash(
        req,
        `Import zakonczony: ${result.created} nowych, ${result.updated} zaktualizowanych` +
          (result.skipped ? `, ${result.skipped} pominietych (brak weryfikacji).` : "."),
        "success",
      );
    } catch (error) {
      const message = error instanceof GoogleApiError ? error.toString() : String(error);
      flash(req, `Nie udalo sie pobrac stron z Search Console: ${message}`, "error");
    }
    res.redirect(303, "/sites");
  }),
);

sitesRouter.post(
  "/add",
  asyncHandler(async (req, res) => {
    const propertyUrl = String(req.body.property_url ?? "").trim();
    if (!propertyUrl) {
      flash(req, "Podaj adres strony.", "error");
      return res.redirect(303, "/sites");
    }
    const site = await siteService.createSite(req.workspace!.id, propertyUrl);
    flash(req, `Dodano strone ${site.display_name}.`, "success");
    res.redirect(303, back(site.id));
  }),
);

sitesRouter.post(
  "/run-all",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const started = runInBackground(`workspace:${workspace.id}`, () =>
      tasks.taskRunAllSites(workspace.id),
    );
    flash(
      req,
      started ? "Uruchomiono indeksowanie wszystkich stron." : "Indeksowanie juz trwa.",
      started ? "success" : "warning",
    );
    res.redirect(303, "/sites");
  }),
);

sitesRouter.get(
  "/:siteId",
  asyncHandler(async (req, res) => {
    const siteId = Number(req.params.siteId);
    const site = await requireSite(req, siteId);
    const perPage = 50;
    const tab = typeof req.query.tab === "string" ? req.query.tab : "overview";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const page = Math.max(1, Number(req.query.page) || 1);

    let query = db.selectFrom("urls").selectAll().where("site_id", "=", site.id);
    if (status) query = query.where("index_status", "=", status as IndexStatus);
    if (q) query = query.where("url", "like", `%${q}%`);

    const totalRow = await query
      .clearSelect()
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .executeTakeFirst();
    const total = Number(totalRow?.total ?? 0);

    const urls = await query
      .orderBy("index_status")
      .orderBy("id", "desc")
      .offset((page - 1) * perPage)
      .limit(perPage)
      .execute();

    const sitemaps = await sitemapService.listSitemaps(site.id);
    const jobs = await db
      .selectFrom("index_jobs")
      .selectAll()
      .where("site_id", "=", site.id)
      .orderBy("created_at", "desc")
      .limit(30)
      .execute();

    res.render(
      "site_detail.html",
      baseContext(req, {
        user: req.user,
        workspace: req.workspace,
        site,
        stats: await siteUrlStats(site.id),
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
        history: await workspaceIndexingHistory(req.workspace!.id, 30),
        quota_left: await quota.remaining(req.workspace!),
        busy: isRunning(`site:${site.id}`),
        indexnow_url: keyFileUrl(site.home_url, site.indexnow_key || ""),
        active_page: "sites",
      }),
    );
  }),
);

sitesRouter.post(
  "/:siteId/settings",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const displayName = String(req.body.display_name ?? "").trim();
    const dailyLimit = Math.max(0, Math.min(Number(req.body.daily_limit) || 50, 10_000));
    const priority = Math.max(0, Math.min(Number(req.body.priority) || 0, 100));
    const indexnowEnabled = formBool(req.body.indexnow_enabled);
    const isActive = formBool(req.body.is_active);

    await db
      .updateTable("sites")
      .set({
        ...(displayName ? { display_name: displayName.slice(0, 255) } : {}),
        daily_limit: dailyLimit,
        priority,
        // auto_index ma wlasny endpoint /toggle-auto — nie nadpisuj go tu
        indexnow_enabled: indexnowEnabled,
        is_active: isActive,
        ...(indexnowEnabled && !site.indexnow_key
          ? { indexnow_key: generateIndexNowKey() }
          : {}),
      })
      .where("id", "=", site.id)
      .execute();

    flash(req, "Ustawienia strony zapisane.", "success");
    res.redirect(303, back(site.id, "settings"));
  }),
);

sitesRouter.post(
  "/:siteId/toggle-auto",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    // Stan z checkboxa po onchange (nie !db — unikamy race / zlej konwersji TINYINT).
    const enabled =
      "enabled" in (req.body as object)
        ? formBool(req.body.enabled)
        : !Boolean(site.auto_index);
    await db
      .updateTable("sites")
      .set({ auto_index: enabled })
      .where("id", "=", site.id)
      .execute();
    flash(
      req,
      enabled
        ? `Auto-indeks wlaczony dla ${site.display_name} (limit ${site.daily_limit}/dzien).`
        : `Auto-indeks wylaczony dla ${site.display_name}.`,
      "success",
    );
    const redirectTo = String(req.body.redirect || "/sites");
    res.redirect(303, redirectTo.startsWith("/") ? redirectTo : "/sites");
  }),
);

sitesRouter.post(
  "/:siteId/delete",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const name = site.display_name;
    await siteService.deleteSite(site.id, req.workspace!.id);
    flash(req, `Usunieto strone ${name} wraz z jej danymi.`, "success");
    res.redirect(303, "/sites");
  }),
);

sitesRouter.post(
  "/:siteId/regenerate-key",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    await db
      .updateTable("sites")
      .set({ indexnow_key: generateIndexNowKey() })
      .where("id", "=", site.id)
      .execute();
    flash(req, "Wygenerowano nowy klucz IndexNow. Wgraj nowy plik na serwer.", "warning");
    res.redirect(303, back(site.id, "settings"));
  }),
);

sitesRouter.get(
  "/:siteId/indexnow-key",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const key = site.indexnow_key || "";
    res.setHeader("Content-Disposition", `attachment; filename="${key}.txt"`);
    res.type("text/plain").send(key);
  }),
);

sitesRouter.post(
  "/:siteId/scan",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const started = runInBackground(`site:${site.id}`, () => tasks.taskScanSitemaps(site.id));
    flash(
      req,
      started ? "Skanowanie sitemap uruchomione w tle." : "Zadanie dla tej strony juz trwa.",
      started ? "success" : "warning",
    );
    res.redirect(303, back(site.id, "sitemaps"));
  }),
);

sitesRouter.post(
  "/:siteId/inspect",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const limit = Math.max(1, Number(req.body.limit) || 50);
    const started = runInBackground(`site:${site.id}`, () => tasks.taskInspect(site.id, limit));
    flash(
      req,
      started
        ? `Inspekcja ${limit} URL-i uruchomiona w tle.`
        : "Zadanie dla tej strony juz trwa.",
      started ? "success" : "warning",
    );
    res.redirect(303, back(site.id, "urls"));
  }),
);

sitesRouter.post(
  "/:siteId/run",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    if ((await quota.remaining(req.workspace!)) <= 0) {
      flash(req, "Dzienny limit zgloszen zostal wyczerpany.", "warning");
      return res.redirect(303, back(site.id));
    }
    const scan = formBool(req.body.scan) || req.body.scan === undefined;
    const started = runInBackground(`site:${site.id}`, () => tasks.taskRunPipeline(site.id, scan));
    flash(
      req,
      started
        ? "Indeksowanie uruchomione: skan sitemap, inspekcja i zgloszenia."
        : "Zadanie dla tej strony juz trwa.",
      started ? "success" : "warning",
    );
    res.redirect(303, back(site.id));
  }),
);

sitesRouter.post(
  "/:siteId/sitemaps/add",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const path = String(req.body.path ?? "").trim();
    const sitemap = await sitemapService.addSitemap(site, path);
    flash(req, `Dodano sitemape ${sitemap.path}.`, "success");
    if (formBool(req.body.submit_to_google)) {
      const job = await sitemapService.submitToGoogle(req.user!.id, site, sitemap);
      flash(
        req,
        job.message || "Zgloszono sitemape.",
        job.status === JobStatus.SUCCESS ? "success" : "error",
      );
    }
    res.redirect(303, back(site.id, "sitemaps"));
  }),
);

sitesRouter.post(
  "/:siteId/sitemaps/sync",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    try {
      const result = await sitemapService.syncFromGsc(req.user!.id, site);
      flash(
        req,
        `Zsynchronizowano sitemapy z GSC: ${result.created} nowych, ${result.updated} zaktualizowanych.`,
        "success",
      );
    } catch (error) {
      const message = error instanceof GoogleApiError ? error.toString() : String(error);
      flash(req, `Blad synchronizacji sitemap: ${message}`, "error");
    }
    res.redirect(303, back(site.id, "sitemaps"));
  }),
);

sitesRouter.post(
  "/:siteId/sitemaps/discover",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const found = await sitemapService.discoverSitemaps(site);
    flash(
      req,
      found.length ? `Znaleziono ${found.length} sitemap.` : "Nie znaleziono zadnej sitemapy.",
      found.length ? "success" : "warning",
    );
    res.redirect(303, back(site.id, "sitemaps"));
  }),
);

sitesRouter.post(
  "/:siteId/sitemaps/:sitemapId/submit",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const sitemap = await sitemapService.getSitemap(Number(req.params.sitemapId), site.id);
    if (!sitemap) {
      flash(req, "Nie znaleziono sitemapy.", "error");
      return res.redirect(303, back(site.id, "sitemaps"));
    }
    const job = await sitemapService.submitToGoogle(req.user!.id, site, sitemap);
    flash(
      req,
      job.message || "Zgloszono sitemape.",
      job.status === JobStatus.SUCCESS ? "success" : "error",
    );
    res.redirect(303, back(site.id, "sitemaps"));
  }),
);

sitesRouter.post(
  "/:siteId/sitemaps/:sitemapId/scan",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const sitemap = await sitemapService.getSitemap(Number(req.params.sitemapId), site.id);
    if (!sitemap) {
      flash(req, "Nie znaleziono sitemapy.", "error");
      return res.redirect(303, back(site.id, "sitemaps"));
    }
    const result = await sitemapService.scanSitemap(site, sitemap);
    if (result.error) flash(req, `Blad skanowania: ${result.error}`, "error");
    else {
      flash(
        req,
        `Zaimportowano ${result.added} nowych URL-i (${result.duplicates} juz istnialo).`,
        "success",
      );
    }
    res.redirect(303, back(site.id, "sitemaps"));
  }),
);

sitesRouter.post(
  "/:siteId/sitemaps/:sitemapId/delete",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.params.siteId));
    const sitemap = await sitemapService.getSitemap(Number(req.params.sitemapId), site.id);
    if (!sitemap) {
      flash(req, "Nie znaleziono sitemapy.", "error");
      return res.redirect(303, back(site.id, "sitemaps"));
    }
    if (formBool(req.body.from_google)) {
      const job = await sitemapService.deleteFromGoogle(req.user!.id, site, sitemap);
      if (job.status !== JobStatus.SUCCESS) flash(req, `Google: ${job.message}`, "warning");
    }
    await sitemapService.deleteSitemap(sitemap.id, site.id);
    flash(req, "Sitemapa usunieta.", "success");
    res.redirect(303, back(site.id, "sitemaps"));
  }),
);
