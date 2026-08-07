import crypto from "node:crypto";
import { config } from "../config.js";
import { applyNoStore, saveSession } from "./auth.js";
/** Zapamietanie wejscia przez bramke — 90 dni. */
const GATE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const GATE_COOKIE = "imp_gate";
function passwordMatches(candidate, expected) {
    const left = crypto.createHash("sha256").update(candidate, "utf8").digest();
    const right = crypto.createHash("sha256").update(expected, "utf8").digest();
    return crypto.timingSafeEqual(left, right);
}
function readCookie(req, name) {
    const raw = req.headers.cookie;
    if (!raw)
        return undefined;
    for (const part of raw.split(";")) {
        const trimmed = part.trim();
        const eq = trimmed.indexOf("=");
        if (eq <= 0)
            continue;
        if (trimmed.slice(0, eq) !== name)
            continue;
        try {
            return decodeURIComponent(trimmed.slice(eq + 1));
        }
        catch {
            return trimmed.slice(eq + 1);
        }
    }
    return undefined;
}
function signGateToken(expiresAt) {
    const payload = String(expiresAt);
    const sig = crypto
        .createHmac("sha256", config.secretKey)
        .update(`site_gate:${payload}`)
        .digest("base64url");
    return `${payload}.${sig}`;
}
function gateCookieValid(req) {
    const token = readCookie(req, GATE_COOKIE);
    if (!token)
        return false;
    const dot = token.indexOf(".");
    if (dot <= 0)
        return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expiresAt = Number(payload);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt)
        return false;
    const expected = crypto
        .createHmac("sha256", config.secretKey)
        .update(`site_gate:${payload}`)
        .digest("base64url");
    const left = Buffer.from(sig);
    const right = Buffer.from(expected);
    if (left.length !== right.length)
        return false;
    return crypto.timingSafeEqual(left, right);
}
function setGateCookie(res) {
    const expiresAt = Date.now() + GATE_TTL_MS;
    res.cookie(GATE_COOKIE, signGateToken(expiresAt), {
        maxAge: GATE_TTL_MS,
        httpOnly: true,
        sameSite: "lax",
        secure: config.isHttps,
        path: "/",
    });
}
function clearGateCookie(res) {
    res.clearCookie(GATE_COOKIE, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.isHttps,
        path: "/",
    });
}
export function hasGateAccess(req) {
    return Boolean(req.session?.site_gate) || gateCookieValid(req);
}
function renderGate(res, error = "") {
    applyNoStore(res);
    res.status(error ? 401 : 200).render("gate.html", {
        app_name: config.appName,
        error,
    });
}
/** Trasy, ktore omijaja bramke haslem (health + same logowanie do bramki). */
function isGateExempt(req) {
    const path = req.path || "/";
    return (path === "/healthz" ||
        path.startsWith("/static/") ||
        path === "/gate" ||
        path === "/gate/login" ||
        path === "/gate/logout");
}
export const siteGate = (req, res, next) => {
    if (!config.siteGatePassword)
        return next();
    if (isGateExempt(req))
        return next();
    if (hasGateAccess(req)) {
        // Synchronizuj flage sesji, gdy wpuscilo samo cookie (np. po restartcie sesji).
        if (!req.session.site_gate && gateCookieValid(req)) {
            req.session.site_gate = true;
        }
        return next();
    }
    if (req.path.startsWith("/api/") || req.originalUrl.startsWith("/api/")) {
        applyNoStore(res);
        res.status(401).json({ detail: "Site gate: required" });
        return;
    }
    renderGate(res);
};
export async function handleGateLogin(req, res) {
    if (!config.siteGatePassword) {
        res.redirect(303, "/");
        return;
    }
    const password = String(req.body.password ?? "");
    if (!password || !passwordMatches(password, config.siteGatePassword)) {
        renderGate(res, "Nieprawidlowe haslo.");
        return;
    }
    req.session.site_gate = true;
    setGateCookie(res);
    await saveSession(req);
    const nextUrl = typeof req.body.next === "string" &&
        req.body.next.startsWith("/") &&
        !req.body.next.startsWith("//")
        ? req.body.next
        : "/";
    applyNoStore(res);
    res.redirect(303, nextUrl);
}
export async function handleGateLogout(req, res, _next) {
    delete req.session.site_gate;
    clearGateCookie(res);
    await saveSession(req);
    applyNoStore(res);
    res.redirect(303, "/gate");
}
//# sourceMappingURL=siteGate.js.map