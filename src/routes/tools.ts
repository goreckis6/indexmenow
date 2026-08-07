import { Router } from "express";
import { db } from "../db/index.js";
import { JobStatus, JobType, type PageUrl } from "../db/types.js";
import { sha256 } from "../lib/crypto.js";
import { asyncHandler, flash, requireSite } from "../middleware/auth.js";
import * as indexer from "../services/indexer.js";
import { fetchPageMeta } from "../services/seoTools.js";
import { crawlSitemap } from "../services/sitemapParser.js";
import { listSites } from "../services/sites.js";
import { normalizeUrl, parseUrlBlob } from "../services/urls.js";
import { baseContext } from "../templating.js";
import { panelAuth } from "./auth.js";

export const toolsRouter = Router();
toolsRouter.use(...panelAuth);

toolsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.render(
      "tools.html",
      baseContext(req, {
        user: req.user,
        workspace: req.workspace,
        sites: await listSites(req.workspace!.id),
        active_page: "tools",
        tool: typeof req.query.tool === "string" ? req.query.tool : "instant",
      }),
    );
  }),
);

toolsRouter.post(
  "/instant",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.body.site_id));
    const candidates = parseUrlBlob(String(req.body.urls_blob ?? ""));
    if (candidates.length === 0) {
      flash(req, "Nie podano poprawnych adresow URL.", "error");
      return res.redirect(303, "/tools?tool=instant");
    }

    const jobType =
      req.body.notification_type === "URL_DELETED" ? JobType.URL_DELETED : JobType.URL_UPDATED;
    const results = { success: 0, failed: 0, messages: [] as string[] };
    const ctx = {
      userId: req.user!.id,
      userEmail: req.user!.email,
      workspace: req.workspace!,
    };

    for (const url of candidates.slice(0, 50)) {
      let page: PageUrl | undefined = await db
        .selectFrom("urls")
        .selectAll()
        .where("site_id", "=", site.id)
        .where("url_hash", "=", sha256(url))
        .executeTakeFirst();

      if (!page) {
        const inserted = await db
          .insertInto("urls")
          .values({
            site_id: site.id,
            url: url.slice(0, 2048),
            url_hash: sha256(url),
            source: "manual",
          })
          .executeTakeFirst();
        page = await db
          .selectFrom("urls")
          .selectAll()
          .where("id", "=", Number(inserted.insertId))
          .executeTakeFirstOrThrow();
      }

      const job = await indexer.submitSingle(ctx, site, page, url, jobType, "manual");
      if (job.status === JobStatus.SUCCESS) results.success += 1;
      else {
        results.failed += 1;
        if (job.message) results.messages.push(`${url}: ${job.message}`);
      }
    }

    if (results.success) {
      flash(req, `Zgloszono ${results.success} URL-i do Google.`, "success");
    }
    for (const message of results.messages.slice(0, 3)) flash(req, message, "error");
    res.redirect(303, "/tools?tool=instant");
  }),
);

toolsRouter.post(
  "/indexnow",
  asyncHandler(async (req, res) => {
    const site = await requireSite(req, Number(req.body.site_id));
    const candidates = parseUrlBlob(String(req.body.urls_blob ?? ""));
    if (candidates.length === 0) {
      flash(req, "Nie podano poprawnych adresow URL.", "error");
      return res.redirect(303, "/tools?tool=indexnow");
    }
    const result = await indexer.submitIndexNow(site, candidates);
    flash(req, `IndexNow: ${result.message}`, result.ok ? "success" : "error");
    res.redirect(303, "/tools?tool=indexnow");
  }),
);

toolsRouter.get(
  "/preview",
  asyncHandler(async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    let meta = null;
    if (url) {
      const normalized = normalizeUrl(url);
      meta = normalized
        ? await fetchPageMeta(normalized)
        : { url, error: "Nieprawidlowy URL." };
    }
    res.render(
      "tools.html",
      baseContext(req, {
        user: req.user,
        workspace: req.workspace,
        sites: await listSites(req.workspace!.id),
        meta,
        preview_url: url,
        tool: "preview",
        active_page: "tools",
      }),
    );
  }),
);

toolsRouter.get(
  "/sitemap",
  asyncHandler(async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    let result = null;
    if (url) {
      const normalized = normalizeUrl(url);
      if (normalized) {
        const crawled = await crawlSitemap(normalized);
        result = {
          source: crawled.source,
          is_index: crawled.isIndex,
          error: crawled.error,
          child_sitemaps: crawled.childSitemaps,
          count: crawled.entries.length,
          entries: crawled.entries.slice(0, 500),
        };
      } else {
        result = { error: "Nieprawidlowy URL." };
      }
    }
    res.render(
      "tools.html",
      baseContext(req, {
        user: req.user,
        workspace: req.workspace,
        sites: await listSites(req.workspace!.id),
        sitemap_result: result,
        sitemap_url: url,
        tool: "sitemap",
        active_page: "tools",
      }),
    );
  }),
);
