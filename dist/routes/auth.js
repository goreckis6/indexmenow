import { Router } from "express";
import { sql } from "kysely";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { GoogleApiError } from "../google/errors.js";
import * as oauth from "../google/oauth.js";
import { decrypt, generateState } from "../lib/crypto.js";
import { asyncHandler, flash, loadUser, redirectWithSession, requireAuth, resolveWorkspace, saveSession, } from "../middleware/auth.js";
import { logEvent } from "../services/activity.js";
import { createDefaultWorkspace } from "../services/workspaces.js";
import { baseContext } from "../templating.js";
export const authRouter = Router();
authRouter.get("/login", loadUser, asyncHandler(async (req, res) => {
    if (req.user) {
        const rawNext = typeof req.query.next === "string" ? req.query.next : "/";
        const nextUrl = rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/login")
            ? rawNext
            : "/";
        return redirectWithSession(req, res, nextUrl);
    }
    res.render("login.html", baseContext(req, {
        google_configured: config.googleConfigured,
        redirect_uri: config.redirectUri,
        next: typeof req.query.next === "string" ? req.query.next : "/",
    }));
}));
authRouter.get("/auth/google", asyncHandler(async (req, res) => {
    if (!config.googleConfigured) {
        flash(req, "Brak konfiguracji Google OAuth w pliku .env", "error");
        return redirectWithSession(req, res, "/login");
    }
    const state = generateState();
    req.session.oauth_state = state;
    req.session.oauth_next = typeof req.query.next === "string" ? req.query.next : "/";
    await saveSession(req);
    res.redirect(303, oauth.buildAuthorizationUrl(state));
}));
authRouter.get("/auth/callback", asyncHandler(async (req, res) => {
    const error = typeof req.query.error === "string" ? req.query.error : null;
    if (error) {
        flash(req, `Logowanie anulowane: ${error}`, "error");
        return redirectWithSession(req, res, "/login");
    }
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const expected = req.session.oauth_state;
    delete req.session.oauth_state;
    if (!code || !state || state !== expected) {
        flash(req, "Nieprawidlowy stan logowania. Sprobuj ponownie.", "error");
        return redirectWithSession(req, res, "/login");
    }
    let tokenData;
    let profile;
    try {
        tokenData = await oauth.exchangeCode(code);
        profile = await oauth.fetchUserinfo(tokenData.access_token);
    }
    catch (err) {
        const message = err instanceof GoogleApiError ? err.toString() : String(err);
        console.error("OAuth failed:", message);
        flash(req, `Blad logowania Google: ${message}`, "error");
        return redirectWithSession(req, res, "/login");
    }
    const email = (profile.email ?? "").toLowerCase();
    if (!email) {
        flash(req, "Konto Google nie udostepnilo adresu e-mail.", "error");
        return redirectWithSession(req, res, "/login");
    }
    const allowed = config.allowedEmailList;
    if (allowed.length > 0 && !allowed.includes(email)) {
        flash(req, `Konto ${email} nie ma dostepu do tego panelu.`, "error");
        return redirectWithSession(req, res, "/login");
    }
    let user = (await db
        .selectFrom("users")
        .selectAll()
        .where("google_sub", "=", profile.sub)
        .executeTakeFirst()) ??
        (await db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst());
    const countRow = await db
        .selectFrom("users")
        .select(sql `COUNT(id)`.as("total"))
        .executeTakeFirst();
    const isFirstUser = Number(countRow?.total ?? 0) === 0;
    let created = false;
    if (!user) {
        const inserted = await db
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
        user = await db
            .selectFrom("users")
            .selectAll()
            .where("id", "=", Number(inserted.insertId))
            .executeTakeFirstOrThrow();
        created = true;
    }
    else {
        await db
            .updateTable("users")
            .set({
            email,
            name: profile.name ?? user.name,
            picture: profile.picture ?? user.picture,
            google_sub: profile.sub,
        })
            .where("id", "=", user.id)
            .execute();
        user = await db
            .selectFrom("users")
            .selectAll()
            .where("id", "=", user.id)
            .executeTakeFirstOrThrow();
    }
    if (!user.is_active) {
        flash(req, "To konto zostalo zablokowane przez administratora.", "error");
        return redirectWithSession(req, res, "/login");
    }
    await db
        .updateTable("users")
        .set({ last_login_at: new Date() })
        .where("id", "=", user.id)
        .execute();
    await oauth.storeCredentials(user.id, tokenData);
    let workspace = await db
        .selectFrom("workspaces")
        .selectAll()
        .where("user_id", "=", user.id)
        .orderBy("id")
        .executeTakeFirst();
    if (!workspace)
        workspace = await createDefaultWorkspace(user);
    const rawNext = req.session.oauth_next || "/";
    delete req.session.oauth_next;
    let nextUrl = rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/login")
        ? rawNext
        : "/";
    // Nowa sesja po loginie — unikamy fixacji ID sesji i wymuszamy zapis do MySQL
    // zanim padnie Location (inaczej / ↔ /login na Hostingerze).
    await new Promise((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.user_id = user.id;
    req.session.workspace_id = workspace.id;
    const granted = tokenData.scope ?? "";
    const missing = oauth.SCOPES.filter((s) => s.startsWith("https://") && !granted.includes(s));
    if (missing.length > 0) {
        flash(req, "Nie przyznano wszystkich uprawnien - indeksowanie moze nie dzialac. Wyloguj sie i zaloguj ponownie zaznaczajac wszystkie zgody.", "warning");
    }
    await logEvent(`${created ? "Nowe konto" : "Logowanie"}: ${email}`, {
        workspaceId: workspace.id,
        category: "auth",
    });
    flash(req, `Zalogowano jako ${user.name || email}.`, "success");
    await redirectWithSession(req, res, nextUrl);
}));
authRouter.get("/logout", loadUser, asyncHandler(async (req, res) => {
    if (req.user && req.query.revoke === "1") {
        const credential = await oauth.getCredential(req.user.id);
        const token = credential ? decrypt(credential.access_token_enc) : null;
        if (token)
            await oauth.revokeToken(token);
        if (credential) {
            await db.deleteFrom("google_credentials").where("user_id", "=", req.user.id).execute();
        }
    }
    req.session.destroy(() => {
        // flash po destroy nie zadziała - przekierowanie wystarczy
    });
    res.redirect(303, "/login");
}));
authRouter.post("/logout", loadUser, (req, res) => {
    req.session.destroy(() => undefined);
    res.redirect(303, "/login");
});
/** Middleware stosowane do chronionych stron panelu. */
export const panelAuth = [loadUser, requireAuth, resolveWorkspace];
//# sourceMappingURL=auth.js.map