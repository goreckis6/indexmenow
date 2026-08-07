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
exports.settingsRouter = void 0;
const express_1 = require("express");
const db_1 = require("../db");
const errors_1 = require("../google/errors");
const oauth = __importStar(require("../google/oauth"));
const gsc = __importStar(require("../google/searchConsole"));
const serviceAccount_1 = require("../google/serviceAccount");
const crypto_1 = require("../lib/crypto");
const auth_1 = require("../middleware/auth");
const quota = __importStar(require("../services/quota"));
const scheduler_1 = require("../services/scheduler");
const workspaces_1 = require("../services/workspaces");
const templating_1 = require("../templating");
const auth_2 = require("./auth");
exports.settingsRouter = (0, express_1.Router)();
exports.settingsRouter.use(...auth_2.panelAuth);
function formBool(value) {
    return value === "on" || value === "true" || value === "1" || value === true;
}
exports.settingsRouter.get("/", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const user = req.user;
    const accounts = await db_1.db
        .selectFrom("service_accounts")
        .selectAll()
        .where("workspace_id", "=", workspace.id)
        .orderBy("id")
        .execute();
    const credential = await oauth.getCredential(user.id);
    const siteCount = await db_1.db
        .selectFrom("sites")
        .select((eb) => eb.fn.countAll().as("total"))
        .where("workspace_id", "=", workspace.id)
        .executeTakeFirst();
    res.render("settings.html", (0, templating_1.baseContext)(req, {
        user,
        workspace,
        workspaces: await (0, workspaces_1.listWorkspaces)(user.id),
        service_accounts: accounts,
        scopes: credential ? oauth.scopeList(credential) : [],
        required_scopes: oauth.SCOPES,
        quota_used: await quota.getUsage(workspace.id),
        quota_history: await quota.usageHistory(workspace.id, 14),
        next_runs: (0, scheduler_1.nextRunTimes)(),
        running: (0, scheduler_1.runningTasks)(),
        site_count: Number(siteCount?.total ?? 0),
        active_page: "settings",
    }));
}));
exports.settingsRouter.post("/workspace", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const name = String(req.body.name ?? "").trim().slice(0, 120) || workspace.name;
    const dailyQuota = Math.max(0, Math.min(Number(req.body.daily_quota) || 200, 100_000));
    await db_1.db
        .updateTable("workspaces")
        .set({
        name,
        daily_quota: dailyQuota,
        auto_index_enabled: formBool(req.body.auto_index_enabled),
    })
        .where("id", "=", workspace.id)
        .execute();
    (0, auth_1.flash)(req, "Ustawienia workspace zapisane.", "success");
    res.redirect(303, "/settings");
}));
exports.settingsRouter.post("/workspace/create", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = await (0, workspaces_1.createWorkspace)(req.user.id, String(req.body.name ?? ""));
    req.session.workspace_id = workspace.id;
    (0, auth_1.flash)(req, `Utworzono workspace ${workspace.name}.`, "success");
    res.redirect(303, "/settings");
}));
exports.settingsRouter.post("/workspace/switch", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspaceId = Number(req.body.workspace_id);
    const target = (await (0, workspaces_1.listWorkspaces)(req.user.id)).find((w) => w.id === workspaceId);
    if (!target)
        (0, auth_1.flash)(req, "Nie znaleziono workspace.", "error");
    else {
        req.session.workspace_id = target.id;
        (0, auth_1.flash)(req, `Przelaczono na ${target.name}.`, "success");
    }
    res.redirect(303, "/");
}));
exports.settingsRouter.post("/service-account", (0, auth_1.asyncHandler)(async (req, res) => {
    const workspace = req.workspace;
    const file = req.file;
    if (!file?.buffer) {
        (0, auth_1.flash)(req, "Wybierz plik JSON konta serwisowego.", "error");
        return res.redirect(303, "/settings");
    }
    let info;
    try {
        info = (0, serviceAccount_1.parseServiceAccountJson)(file.buffer.toString("utf8"));
        await (0, serviceAccount_1.getServiceAccountToken)(info);
    }
    catch (error) {
        const message = error instanceof errors_1.GoogleApiError ? error.toString() : String(error);
        (0, auth_1.flash)(req, `Nie udalo sie dodac konta serwisowego: ${message}`, "error");
        return res.redirect(303, "/settings");
    }
    const existing = await db_1.db
        .selectFrom("service_accounts")
        .select("id")
        .where("workspace_id", "=", workspace.id)
        .where("client_email", "=", info.client_email)
        .executeTakeFirst();
    if (existing) {
        (0, auth_1.flash)(req, "To konto serwisowe jest juz dodane.", "warning");
        return res.redirect(303, "/settings");
    }
    const label = String(req.body.label ?? "").trim();
    await db_1.db
        .insertInto("service_accounts")
        .values({
        workspace_id: workspace.id,
        name: label || info.client_email.split("@")[0] || "service-account",
        client_email: info.client_email,
        project_id: info.project_id ?? null,
        private_key_id: info.private_key_id ?? null,
        private_key_enc: (0, crypto_1.encrypt)(info.private_key),
        daily_quota: Math.max(1, Number(req.body.daily_quota) || 200),
    })
        .execute();
    (0, auth_1.flash)(req, `Dodano konto serwisowe ${info.client_email}. Pamietaj, aby dodac je jako wlasciciela w Google Search Console.`, "success");
    res.redirect(303, "/settings");
}));
exports.settingsRouter.post("/service-account/:accountId/toggle", (0, auth_1.asyncHandler)(async (req, res) => {
    const account = await db_1.db
        .selectFrom("service_accounts")
        .selectAll()
        .where("id", "=", Number(req.params.accountId))
        .where("workspace_id", "=", req.workspace.id)
        .executeTakeFirst();
    if (!account)
        (0, auth_1.flash)(req, "Nie znaleziono konta serwisowego.", "error");
    else {
        await db_1.db
            .updateTable("service_accounts")
            .set({ is_active: !account.is_active })
            .where("id", "=", account.id)
            .execute();
        (0, auth_1.flash)(req, `Konto ${account.client_email} zostalo ${!account.is_active ? "wlaczone" : "wylaczone"}.`, "success");
    }
    res.redirect(303, "/settings");
}));
exports.settingsRouter.post("/service-account/:accountId/delete", (0, auth_1.asyncHandler)(async (req, res) => {
    const result = await db_1.db
        .deleteFrom("service_accounts")
        .where("id", "=", Number(req.params.accountId))
        .where("workspace_id", "=", req.workspace.id)
        .executeTakeFirst();
    (0, auth_1.flash)(req, Number(result.numDeletedRows) > 0
        ? "Konto serwisowe usuniete."
        : "Nie znaleziono konta serwisowego.", Number(result.numDeletedRows) > 0 ? "success" : "error");
    res.redirect(303, "/settings");
}));
exports.settingsRouter.post("/test-connection", (0, auth_1.asyncHandler)(async (req, res) => {
    try {
        const token = await oauth.getAccessToken(req.user.id);
        const sites = await gsc.listSites(token);
        (0, auth_1.flash)(req, `Polaczenie dziala. Konto ${req.user.email} ma dostep do ${sites.length} wlasciwosci w Search Console.`, "success");
    }
    catch (error) {
        const message = error instanceof errors_1.GoogleApiError ? error.toString() : String(error);
        (0, auth_1.flash)(req, `Test polaczenia nie powiodl sie: ${message}`, "error");
    }
    res.redirect(303, "/settings");
}));
//# sourceMappingURL=settings.js.map