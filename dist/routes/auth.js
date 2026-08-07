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
exports.panelAuth = exports.authRouter = void 0;
const express_1 = require("express");
const kysely_1 = require("kysely");
const config_1 = require("../config");
const db_1 = require("../db");
const errors_1 = require("../google/errors");
const oauth = __importStar(require("../google/oauth"));
const crypto_1 = require("../lib/crypto");
const auth_1 = require("../middleware/auth");
const activity_1 = require("../services/activity");
const workspaces_1 = require("../services/workspaces");
const templating_1 = require("../templating");
exports.authRouter = (0, express_1.Router)();
exports.authRouter.get("/login", auth_1.loadUser, (0, auth_1.asyncHandler)(async (req, res) => {
    if (req.user)
        return res.redirect(303, "/");
    res.render("login.html", (0, templating_1.baseContext)(req, {
        google_configured: config_1.config.googleConfigured,
        redirect_uri: config_1.config.redirectUri,
        next: typeof req.query.next === "string" ? req.query.next : "/",
    }));
}));
exports.authRouter.get("/auth/google", (req, res) => {
    if (!config_1.config.googleConfigured) {
        (0, auth_1.flash)(req, "Brak konfiguracji Google OAuth w pliku .env", "error");
        return res.redirect(303, "/login");
    }
    const state = (0, crypto_1.generateState)();
    req.session.oauth_state = state;
    req.session.oauth_next = typeof req.query.next === "string" ? req.query.next : "/";
    res.redirect(303, oauth.buildAuthorizationUrl(state));
});
exports.authRouter.get("/auth/callback", (0, auth_1.asyncHandler)(async (req, res) => {
    const error = typeof req.query.error === "string" ? req.query.error : null;
    if (error) {
        (0, auth_1.flash)(req, `Logowanie anulowane: ${error}`, "error");
        return res.redirect(303, "/login");
    }
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const expected = req.session.oauth_state;
    delete req.session.oauth_state;
    if (!code || !state || state !== expected) {
        (0, auth_1.flash)(req, "Nieprawidlowy stan logowania. Sprobuj ponownie.", "error");
        return res.redirect(303, "/login");
    }
    let tokenData;
    let profile;
    try {
        tokenData = await oauth.exchangeCode(code);
        profile = await oauth.fetchUserinfo(tokenData.access_token);
    }
    catch (err) {
        const message = err instanceof errors_1.GoogleApiError ? err.toString() : String(err);
        console.error("OAuth failed:", message);
        (0, auth_1.flash)(req, `Blad logowania Google: ${message}`, "error");
        return res.redirect(303, "/login");
    }
    const email = (profile.email ?? "").toLowerCase();
    if (!email) {
        (0, auth_1.flash)(req, "Konto Google nie udostepnilo adresu e-mail.", "error");
        return res.redirect(303, "/login");
    }
    const allowed = config_1.config.allowedEmailList;
    if (allowed.length > 0 && !allowed.includes(email)) {
        (0, auth_1.flash)(req, `Konto ${email} nie ma dostepu do tego panelu.`, "error");
        return res.redirect(303, "/login");
    }
    let user = (await db_1.db
        .selectFrom("users")
        .selectAll()
        .where("google_sub", "=", profile.sub)
        .executeTakeFirst()) ??
        (await db_1.db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst());
    const countRow = await db_1.db
        .selectFrom("users")
        .select((0, kysely_1.sql) `COUNT(id)`.as("total"))
        .executeTakeFirst();
    const isFirstUser = Number(countRow?.total ?? 0) === 0;
    let created = false;
    if (!user) {
        const inserted = await db_1.db
            .insertInto("users")
            .values({
            google_sub: profile.sub,
            email,
            name: profile.name ?? null,
            picture: profile.picture ?? null,
            locale: profile.locale ?? null,
            is_admin: isFirstUser,
        })
            .executeTakeFirst();
        user = await db_1.db
            .selectFrom("users")
            .selectAll()
            .where("id", "=", Number(inserted.insertId))
            .executeTakeFirstOrThrow();
        created = true;
    }
    else {
        await db_1.db
            .updateTable("users")
            .set({
            email,
            name: profile.name ?? user.name,
            picture: profile.picture ?? user.picture,
            google_sub: profile.sub,
        })
            .where("id", "=", user.id)
            .execute();
        user = await db_1.db
            .selectFrom("users")
            .selectAll()
            .where("id", "=", user.id)
            .executeTakeFirstOrThrow();
    }
    if (!user.is_active) {
        (0, auth_1.flash)(req, "To konto zostalo zablokowane przez administratora.", "error");
        return res.redirect(303, "/login");
    }
    await db_1.db
        .updateTable("users")
        .set({ last_login_at: new Date() })
        .where("id", "=", user.id)
        .execute();
    await oauth.storeCredentials(user.id, tokenData);
    let workspace = await db_1.db
        .selectFrom("workspaces")
        .selectAll()
        .where("user_id", "=", user.id)
        .orderBy("id")
        .executeTakeFirst();
    if (!workspace)
        workspace = await (0, workspaces_1.createDefaultWorkspace)(user);
    req.session.user_id = user.id;
    req.session.workspace_id = workspace.id;
    const granted = tokenData.scope ?? "";
    const missing = oauth.SCOPES.filter((s) => s.startsWith("https://") && !granted.includes(s));
    if (missing.length > 0) {
        (0, auth_1.flash)(req, "Nie przyznano wszystkich uprawnien - indeksowanie moze nie dzialac. Wyloguj sie i zaloguj ponownie zaznaczajac wszystkie zgody.", "warning");
    }
    await (0, activity_1.logEvent)(`${created ? "Nowe konto" : "Logowanie"}: ${email}`, {
        workspaceId: workspace.id,
        category: "auth",
    });
    (0, auth_1.flash)(req, `Zalogowano jako ${user.name || email}.`, "success");
    let nextUrl = req.session.oauth_next || "/";
    delete req.session.oauth_next;
    if (!nextUrl.startsWith("/"))
        nextUrl = "/";
    res.redirect(303, nextUrl);
}));
exports.authRouter.get("/logout", auth_1.loadUser, (0, auth_1.asyncHandler)(async (req, res) => {
    if (req.user && req.query.revoke === "1") {
        const credential = await oauth.getCredential(req.user.id);
        const token = credential ? (0, crypto_1.decrypt)(credential.access_token_enc) : null;
        if (token)
            await oauth.revokeToken(token);
        if (credential) {
            await db_1.db.deleteFrom("google_credentials").where("user_id", "=", req.user.id).execute();
        }
    }
    req.session.destroy(() => {
        // flash po destroy nie zadziała - przekierowanie wystarczy
    });
    res.redirect(303, "/login");
}));
exports.authRouter.post("/logout", auth_1.loadUser, (req, res) => {
    req.session.destroy(() => undefined);
    res.redirect(303, "/login");
});
/** Middleware stosowane do chronionych stron panelu. */
exports.panelAuth = [auth_1.loadUser, auth_1.requireAuth, auth_1.resolveWorkspace];
//# sourceMappingURL=auth.js.map