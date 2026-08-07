import { config } from "../config.js";
import { db } from "../db/index.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { GoogleApiError, parseError, safeJson } from "./errors.js";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/webmasters",
    "https://www.googleapis.com/auth/indexing",
];
export function buildAuthorizationUrl(state, loginHint) {
    const params = new URLSearchParams({
        client_id: config.googleClientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
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
    const body = await safeJson(response);
    if (!response.ok)
        throw parseError(response.status, body);
    return body;
}
export function exchangeCode(code) {
    return postForm(TOKEN_ENDPOINT, {
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
    });
}
export function refreshAccessToken(refreshToken) {
    return postForm(TOKEN_ENDPOINT, {
        refresh_token: refreshToken,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        grant_type: "refresh_token",
    });
}
export async function fetchUserinfo(accessToken) {
    const response = await fetch(USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
    });
    const body = await safeJson(response);
    if (!response.ok)
        throw parseError(response.status, body);
    return body;
}
export async function revokeToken(token) {
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
export function getCredential(userId) {
    return db
        .selectFrom("google_credentials")
        .selectAll()
        .where("user_id", "=", userId)
        .executeTakeFirst();
}
export async function storeCredentials(userId, tokenData) {
    const expiresIn = tokenData.expires_in ?? 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const now = new Date();
    const existing = await getCredential(userId);
    const values = {
        access_token_enc: encrypt(tokenData.access_token),
        token_type: tokenData.token_type ?? "Bearer",
        scopes: tokenData.scope ?? SCOPES.join(" "),
        expires_at: expiresAt,
        updated_at: now,
    };
    if (existing) {
        await db
            .updateTable("google_credentials")
            .set({
            ...values,
            // Google przysyla refresh token tylko przy pierwszej zgodzie. Przy
            // odswiezaniu pola nie ma, a nadpisanie go nullem odcielo by konto.
            ...(tokenData.refresh_token
                ? { refresh_token_enc: encrypt(tokenData.refresh_token) }
                : {}),
        })
            .where("user_id", "=", userId)
            .execute();
    }
    else {
        await db
            .insertInto("google_credentials")
            .values({
            user_id: userId,
            ...values,
            refresh_token_enc: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
        })
            .execute();
    }
    const credential = await getCredential(userId);
    if (!credential)
        throw new GoogleApiError("Nie udalo sie zapisac tokenow Google.");
    return credential;
}
/** Zwraca wazny access token, odswiezajac go, gdy trzeba. */
export async function getAccessToken(userId) {
    const credential = await getCredential(userId);
    if (!credential) {
        throw new GoogleApiError("Brak polaczenia z kontem Google. Zaloguj sie ponownie.", 401);
    }
    const token = decrypt(credential.access_token_enc);
    // 90 sekund zapasu, zeby token nie wygasl w trakcie dluzszej serii zapytan.
    const freshEnough = credential.expires_at !== null && credential.expires_at.getTime() - 90_000 > Date.now();
    if (token && freshEnough)
        return token;
    const refreshToken = decrypt(credential.refresh_token_enc);
    if (!refreshToken) {
        if (token)
            return token;
        throw new GoogleApiError("Token wygasl i brak refresh tokena. Wyloguj sie i zaloguj ponownie.", 401);
    }
    const data = await refreshAccessToken(refreshToken);
    if (!data.refresh_token)
        data.refresh_token = refreshToken;
    const updated = await storeCredentials(userId, data);
    return decrypt(updated.access_token_enc) ?? data.access_token;
}
export function scopeList(credential) {
    return credential.scopes.split(" ").filter(Boolean);
}
export async function hasScope(userId, scope) {
    const credential = await getCredential(userId);
    return credential ? scopeList(credential).includes(scope) : false;
}
//# sourceMappingURL=oauth.js.map