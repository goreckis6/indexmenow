"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCOPES = void 0;
exports.buildAuthorizationUrl = buildAuthorizationUrl;
exports.exchangeCode = exchangeCode;
exports.refreshAccessToken = refreshAccessToken;
exports.fetchUserinfo = fetchUserinfo;
exports.revokeToken = revokeToken;
exports.getCredential = getCredential;
exports.storeCredentials = storeCredentials;
exports.getAccessToken = getAccessToken;
exports.scopeList = scopeList;
exports.hasScope = hasScope;
const config_1 = require("../config");
const db_1 = require("../db");
const crypto_1 = require("../lib/crypto");
const errors_1 = require("./errors");
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
exports.SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/webmasters",
    "https://www.googleapis.com/auth/indexing",
];
function buildAuthorizationUrl(state, loginHint) {
    const params = new URLSearchParams({
        client_id: config_1.config.googleClientId,
        redirect_uri: config_1.config.redirectUri,
        response_type: "code",
        scope: exports.SCOPES.join(" "),
        // offline + prompt=consent to jedyny sposob, zeby Google w ogole przyslalo
        // refresh token. Bez niego panel przestalby dzialac po godzinie.
        access_type: "offline",
        include_granted_scopes: "true",
        prompt: "consent select_account",
        state,
    });
    if (loginHint)
        params.set("login_hint", loginHint);
    return `${AUTH_ENDPOINT}?${params.toString()}`;
}
async function postForm(endpoint, form) {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(30_000),
    });
    const body = await (0, errors_1.safeJson)(response);
    if (!response.ok)
        throw (0, errors_1.parseError)(response.status, body);
    return body;
}
function exchangeCode(code) {
    return postForm(TOKEN_ENDPOINT, {
        code,
        client_id: config_1.config.googleClientId,
        client_secret: config_1.config.googleClientSecret,
        redirect_uri: config_1.config.redirectUri,
        grant_type: "authorization_code",
    });
}
function refreshAccessToken(refreshToken) {
    return postForm(TOKEN_ENDPOINT, {
        refresh_token: refreshToken,
        client_id: config_1.config.googleClientId,
        client_secret: config_1.config.googleClientSecret,
        grant_type: "refresh_token",
    });
}
async function fetchUserinfo(accessToken) {
    const response = await fetch(USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
    });
    const body = await (0, errors_1.safeJson)(response);
    if (!response.ok)
        throw (0, errors_1.parseError)(response.status, body);
    return body;
}
async function revokeToken(token) {
    try {
        await fetch(REVOKE_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token }).toString(),
            signal: AbortSignal.timeout(15_000),
        });
    }
    catch {
        // Wylogowanie nie moze sie wywalic tylko dlatego, ze Google nie odpowiada.
    }
}
function getCredential(userId) {
    return db_1.db
        .selectFrom("google_credentials")
        .selectAll()
        .where("user_id", "=", userId)
        .executeTakeFirst();
}
async function storeCredentials(userId, tokenData) {
    const expiresIn = tokenData.expires_in ?? 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const now = new Date();
    const existing = await getCredential(userId);
    const values = {
        access_token_enc: (0, crypto_1.encrypt)(tokenData.access_token),
        token_type: tokenData.token_type ?? "Bearer",
        scopes: tokenData.scope ?? exports.SCOPES.join(" "),
        expires_at: expiresAt,
        updated_at: now,
    };
    if (existing) {
        await db_1.db
            .updateTable("google_credentials")
            .set({
            ...values,
            // Google przysyla refresh token tylko przy pierwszej zgodzie. Przy
            // odswiezaniu pola nie ma, a nadpisanie go nullem odcielo by konto.
            ...(tokenData.refresh_token
                ? { refresh_token_enc: (0, crypto_1.encrypt)(tokenData.refresh_token) }
                : {}),
        })
            .where("user_id", "=", userId)
            .execute();
    }
    else {
        await db_1.db
            .insertInto("google_credentials")
            .values({
            user_id: userId,
            ...values,
            refresh_token_enc: tokenData.refresh_token ? (0, crypto_1.encrypt)(tokenData.refresh_token) : null,
        })
            .execute();
    }
    const credential = await getCredential(userId);
    if (!credential)
        throw new errors_1.GoogleApiError("Nie udalo sie zapisac tokenow Google.");
    return credential;
}
/** Zwraca wazny access token, odswiezajac go, gdy trzeba. */
async function getAccessToken(userId) {
    const credential = await getCredential(userId);
    if (!credential) {
        throw new errors_1.GoogleApiError("Brak polaczenia z kontem Google. Zaloguj sie ponownie.", 401);
    }
    const token = (0, crypto_1.decrypt)(credential.access_token_enc);
    // 90 sekund zapasu, zeby token nie wygasl w trakcie dluzszej serii zapytan.
    const freshEnough = credential.expires_at !== null && credential.expires_at.getTime() - 90_000 > Date.now();
    if (token && freshEnough)
        return token;
    const refreshToken = (0, crypto_1.decrypt)(credential.refresh_token_enc);
    if (!refreshToken) {
        if (token)
            return token;
        throw new errors_1.GoogleApiError("Token wygasl i brak refresh tokena. Wyloguj sie i zaloguj ponownie.", 401);
    }
    const data = await refreshAccessToken(refreshToken);
    if (!data.refresh_token)
        data.refresh_token = refreshToken;
    const updated = await storeCredentials(userId, data);
    return (0, crypto_1.decrypt)(updated.access_token_enc) ?? data.access_token;
}
function scopeList(credential) {
    return credential.scopes.split(" ").filter(Boolean);
}
async function hasScope(userId, scope) {
    const credential = await getCredential(userId);
    return credential ? scopeList(credential).includes(scope) : false;
}
//# sourceMappingURL=oauth.js.map