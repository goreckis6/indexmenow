import { Router } from "express";
import { sql } from "kysely";
import { db } from "../db";
import { IndexStatus, isDomainProperty } from "../db/types";
import { asyncHandler, flash, requireSite } from "../middleware/auth";
import { sha256 } from "../lib/crypto";
import { runInBackground } from "../services/scheduler";
import { listSites } from "../services/sites";
import { urlBelongsToSite } from "../services/sitemapParser";
import * as tasks from "../services/tasks";
import * as urlService from "../services/urls";
import { baseContext } from "../templating";
import { panelAuth } from "./auth";

export const urlsRouter = Router();
urlsRouter.use(...panelAuth);

const PER_PAGE = 100;

function formBool(value: unknown): boolean {
  return value === "on" || value === "true" || value === "1" || value === true;
}

urlsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const siteId = Number(req.query.site_id) || 0;
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const page = Math.max(1, Number(req.query.page) || 1);

    let query = db
      .selectFrom("urls")
      .innerJoin("sites", "sites.id", "urls.site_id")
      .where("sites.workspace_id", "=", workspace.id);
    if (siteId) query = query.where("urls.site_id", "=", siteId);
    if (status) query = query.where("urls.index_status", "=", status as IndexStatus);
    if (q) query = query.where("urls.url", "like", `%${q}%`);

    const totalRow = await query
      .select(sql<number>`COUNT(urls.id)`.as("total"))
      .executeTakeFirst();
    const total = Number(totalRow?.total ?? 0);

    const rows = await query
      .selectAll("urls")
      .orderBy(sql`urls.last_checked_at IS NULL`, "desc")
      .orderBy("urls.id", "desc")
      .offset((page - 1) * PER_PAGE)
      .limit(PER_PAGE)
      .execute();

    const sites = await listSites(workspace.id);
    const siteMap = Object.fromEntries(sites.map((s) => [s.id, s]));

    res.render(
      "urls.html",
      baseContext(req, {
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
        statuses: Object.values(IndexStatus),
        stats: await urlService.workspaceUrlStats(workspace.id),
        active_page: "urls",
      }),
    );
  }),
);

urlsRouter.post(
  "/add",
  asyncHandler(async (req, res) => {
    const siteId = Number(req.body.site_id);
    const site = await requireSite(req, siteId);
    let blob = String(req.body.urls_blob ?? "");

    const file = req.file;
    if (file?.buffer) {
      try {
        blob += `\n${file.buffer.toString("utf8")}`;
      } catch {
        flash(req, "Nie udalo sie odczytac pliku.", "error");
      }
    }

    const candidates = urlService.parseUrlBlob(blob);
    if (candidates.length === 0) {
      flash(req, "Nie znaleziono zadnego poprawnego adresu URL.", "error");
      return res.redirect(303, `/sites/${siteId}?tab=urls`);
    }

    const valid = candidates.filter((u) =>
      urlBelongsToSite(u, site.home_url, isDomainProperty(site)),
    );
    const rejected = candidates.length - valid.length;
    const priority = Number(req.body.priority) || 0;
    const result = await urlService.addUrls(site, valid, "manual", new Map(), priority);

    let message = `Dodano ${result.added} URL-i (${result.duplicates} juz istnialo).`;
    if (rejected) {
      message += ` Odrzucono ${rejected} adresow spoza domeny ${site.display_name}.`;
    }
    flash(req, message, result.added ? "success" : "warning");

    if (formBool(req.body.submit_now) && result.added) {
      const hashes = valid.map((u) => sha256(u));
      const newIds = (
        await db
          .selectFrom("urls")
          .select("id")
          .where("site_id", "=", site.id)
          .where("url_hash", "in", hashes)
          .execute()
      ).map((r) => r.id);
      runInBackground(`site:${site.id}`, () => tasks.taskSubmitUrls(site.id, newIds));
      flash(req, "Zgloszenie do Google uruchomione w tle.", "success");
    }

    res.redirect(303, `/sites/${siteId}?tab=urls`);
  }),
);

urlsRouter.post(
  "/action",
  asyncHandler(async (req, res) => {
    const action = String(req.body.action ?? "");
    const redirectTo = String(req.body.redirect_to ?? "/urls");
    const rawIds = req.body.url_ids;
    const urlIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [])
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (urlIds.length === 0) {
      flash(req, "Nie zaznaczono zadnego URL-a.", "warning");
      return res.redirect(303, redirectTo);
    }

    const pages = await db
      .selectFrom("urls")
      .innerJoin("sites", "sites.id", "urls.site_id")
      .selectAll("urls")
      .where("urls.id", "in", urlIds)
      .where("sites.workspace_id", "=", req.workspace!.id)
      .execute();

    if (pages.length === 0) {
      flash(req, "Nie znaleziono wskazanych URL-i.", "error");
      return res.redirect(303, redirectTo);
    }

    const bySite = new Map<number, number[]>();
    for (const page of pages) {
      const list = bySite.get(page.site_id) ?? [];
      list.push(page.id);
      bySite.set(page.site_id, list);
    }

    if (action === "submit") {
      for (const [siteId, ids] of bySite) {
        runInBackground(`site:${siteId}`, () => tasks.taskSubmitUrls(siteId, ids));
      }
      flash(req, `Zgloszono ${pages.length} URL-i do indeksowania (w tle).`, "success");
    } else if (action === "inspect") {
      for (const [siteId, ids] of bySite) {
        runInBackground(`site:${siteId}`, () => tasks.taskInspectUrls(siteId, ids));
      }
      flash(req, `Uruchomiono inspekcje ${pages.length} URL-i (w tle).`, "success");
    } else if (action === "delete") {
      await db
        .deleteFrom("urls")
        .where(
          "id",
          "in",
          pages.map((p) => p.id),
        )
        .execute();
      flash(req, `Usunieto ${pages.length} URL-i.`, "success");
    } else if (action === "priority") {
      await db
        .updateTable("urls")
        .set({ priority: 10 })
        .where(
          "id",
          "in",
          pages.map((p) => p.id),
        )
        .execute();
      flash(req, `Ustawiono wysoki priorytet dla ${pages.length} URL-i.`, "success");
    } else if (action === "reset") {
      await db
        .updateTable("urls")
        .set({ index_status: IndexStatus.UNKNOWN, last_checked_at: null })
        .where(
          "id",
          "in",
          pages.map((p) => p.id),
        )
        .execute();
      flash(req, `Zresetowano status ${pages.length} URL-i.`, "success");
    } else {
      flash(req, `Nieznana akcja: ${action}`, "error");
    }

    res.redirect(303, redirectTo);
  }),
);

urlsRouter.get(
  "/export.csv",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const siteId = Number(req.query.site_id) || 0;
    const status = typeof req.query.status === "string" ? req.query.status : "";

    let query = db
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
    if (siteId) query = query.where("urls.site_id", "=", siteId);
    if (status) query = query.where("urls.index_status", "=", status as IndexStatus);

    const rows = await query.execute();
    const header =
      "strona;url;status;coverage_state;verdict;ostatnia_inspekcja;ostatnie_zgloszenie;liczba_zgloszen;zrodlo\n";
    const body = rows
      .map((row) =>
        [
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
          .join(";"),
      )
      .join("\n");

    res.setHeader("Content-Disposition", 'attachment; filename="indexmenow-urls.csv"');
    res.type("text/csv; charset=utf-8").send(header + body);
  }),
);
