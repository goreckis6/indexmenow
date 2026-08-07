import crypto from "node:crypto";
import { config } from "../config.js";
import { applyNoStore, saveSession } from "./auth.js";
function passwordMatches(candidate, expected) {
    const left = crypto.createHash("sha256").update(candidate, "utf8").digest();
    const right = crypto.createHash("sha256").update(expected, "utf8").digest();
    return crypto.timingSafeEqual(left, right);
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
    if (req.session?.site_gate)
        return next();
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
    await saveSession(req);
    applyNoStore(res);
    res.redirect(303, "/gate");
}
//# sourceMappingURL=siteGate.js.map