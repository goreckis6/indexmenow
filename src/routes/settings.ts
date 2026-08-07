import { Router } from "express";
import { db } from "../db/index.js";
import { GoogleApiError } from "../google/errors.js";
import * as oauth from "../google/oauth.js";
import * as gsc from "../google/searchConsole.js";
import { getServiceAccountToken, parseServiceAccountJson } from "../google/serviceAccount.js";
import { encrypt } from "../lib/crypto.js";
import { asyncHandler, flash } from "../middleware/auth.js";
import * as quota from "../services/quota.js";
import { nextRunTimes, runningTasks } from "../services/scheduler.js";
import { createWorkspace, listWorkspaces } from "../services/workspaces.js";
import { baseContext } from "../templating.js";
import { panelAuth } from "./auth.js";

export const settingsRouter = Router();
settingsRouter.use(...panelAuth);

function formBool(value: unknown): boolean {
  return value === "on" || value === "true" || value === "1" || value === true;
}

settingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const user = req.user!;
    const accounts = await db
      .selectFrom("service_accounts")
      .selectAll()
      .where("workspace_id", "=", workspace.id)
      .orderBy("id")
      .execute();

    const credential = await oauth.getCredential(user.id);
    const siteCount = await db
      .selectFrom("sites")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where("workspace_id", "=", workspace.id)
      .executeTakeFirst();

    res.render(
      "settings.html",
      baseContext(req, {
        user,
        workspace,
        workspaces: await listWorkspaces(user.id),
        service_accounts: accounts,
        scopes: credential ? oauth.scopeList(credential) : [],
        required_scopes: oauth.SCOPES,
        quota_used: await quota.getUsage(workspace.id),
        quota_history: await quota.usageHistory(workspace.id, 14),
        next_runs: nextRunTimes(),
        running: runningTasks(),
        site_count: Number(siteCount?.total ?? 0),
        active_page: "settings",
      }),
    );
  }),
);

settingsRouter.post(
  "/workspace",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const name = String(req.body.name ?? "").trim().slice(0, 120) || workspace.name;
    const dailyQuota = Math.max(0, Math.min(Number(req.body.daily_quota) || 200, 100_000));
    await db
      .updateTable("workspaces")
      .set({
        name,
        daily_quota: dailyQuota,
        auto_index_enabled: formBool(req.body.auto_index_enabled),
      })
      .where("id", "=", workspace.id)
      .execute();
    flash(req, "Ustawienia workspace zapisane.", "success");
    res.redirect(303, "/settings");
  }),
);

settingsRouter.post(
  "/workspace/create",
  asyncHandler(async (req, res) => {
    const workspace = await createWorkspace(req.user!.id, String(req.body.name ?? ""));
    req.session.workspace_id = workspace.id;
    flash(req, `Utworzono workspace ${workspace.name}.`, "success");
    res.redirect(303, "/settings");
  }),
);

settingsRouter.post(
  "/workspace/switch",
  asyncHandler(async (req, res) => {
    const workspaceId = Number(req.body.workspace_id);
    const target = (await listWorkspaces(req.user!.id)).find((w) => w.id === workspaceId);
    if (!target) flash(req, "Nie znaleziono workspace.", "error");
    else {
      req.session.workspace_id = target.id;
      flash(req, `Przelaczono na ${target.name}.`, "success");
    }
    res.redirect(303, "/");
  }),
);

settingsRouter.post(
  "/service-account",
  asyncHandler(async (req, res) => {
    const workspace = req.workspace!;
    const file = req.file;
    const pasted = String(req.body.json_text ?? "").trim();
    const raw = file?.buffer ? file.buffer.toString("utf8") : pasted;

    if (!raw) {
      flash(req, "Wklej JSON konta serwisowego albo wybierz plik .json.", "error");
      return res.redirect(303, "/settings");
    }

    let info;
    try {
      info = parseServiceAccountJson(raw);
      await getServiceAccountToken(info);
    } catch (error) {
      const message = error instanceof GoogleApiError ? error.toString() : String(error);
      flash(req, `Nie udalo sie dodac konta serwisowego: ${message}`, "error");
      return res.redirect(303, "/settings");
    }

    const existing = await db
      .selectFrom("service_accounts")
      .select("id")
      .where("workspace_id", "=", workspace.id)
      .where("client_email", "=", info.client_email)
      .executeTakeFirst();
    if (existing) {
      flash(req, "To konto serwisowe jest juz dodane.", "warning");
      return res.redirect(303, "/settings");
    }

    const label = String(req.body.label ?? "").trim();
    await db
      .insertInto("service_accounts")
      .values({
        workspace_id: workspace.id,
        name: label || info.client_email.split("@")[0] || "service-account",
        client_email: info.client_email,
        project_id: info.project_id ?? null,
        private_key_id: info.private_key_id ?? null,
        private_key_enc: encrypt(info.private_key) as string,
        daily_quota: Math.max(1, Number(req.body.daily_quota) || 200),
      })
      .execute();

    flash(
      req,
      `Dodano konto serwisowe ${info.client_email}. Pamietaj, aby dodac je jako wlasciciela w Google Search Console.`,
      "success",
    );
    res.redirect(303, "/settings");
  }),
);

settingsRouter.post(
  "/service-account/:accountId/toggle",
  asyncHandler(async (req, res) => {
    const account = await db
      .selectFrom("service_accounts")
      .selectAll()
      .where("id", "=", Number(req.params.accountId))
      .where("workspace_id", "=", req.workspace!.id)
      .executeTakeFirst();
    if (!account) flash(req, "Nie znaleziono konta serwisowego.", "error");
    else {
      await db
        .updateTable("service_accounts")
        .set({ is_active: !account.is_active })
        .where("id", "=", account.id)
        .execute();
      flash(
        req,
        `Konto ${account.client_email} zostalo ${!account.is_active ? "wlaczone" : "wylaczone"}.`,
        "success",
      );
    }
    res.redirect(303, "/settings");
  }),
);

settingsRouter.post(
  "/service-account/:accountId/delete",
  asyncHandler(async (req, res) => {
    const result = await db
      .deleteFrom("service_accounts")
      .where("id", "=", Number(req.params.accountId))
      .where("workspace_id", "=", req.workspace!.id)
      .executeTakeFirst();
    flash(
      req,
      Number(result.numDeletedRows) > 0
        ? "Konto serwisowe usuniete."
        : "Nie znaleziono konta serwisowego.",
      Number(result.numDeletedRows) > 0 ? "success" : "error",
    );
    res.redirect(303, "/settings");
  }),
);

settingsRouter.post(
  "/test-connection",
  asyncHandler(async (req, res) => {
    try {
      const token = await oauth.getAccessToken(req.user!.id);
      const sites = await gsc.listSites(token);
      flash(
        req,
        `Polaczenie dziala. Konto ${req.user!.email} ma dostep do ${sites.length} wlasciwosci w Search Console.`,
        "success",
      );
    } catch (error) {
      const message = error instanceof GoogleApiError ? error.toString() : String(error);
      flash(req, `Test polaczenia nie powiodl sie: ${message}`, "error");
    }
    res.redirect(303, "/settings");
  }),
);
