import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config, getSiteGatePassword } from "../config.js";
import { applyNoStore, saveSession } from "./auth.js";

/** Zapamietanie wejscia przez bramke — 90 dni. */
const GATE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const GATE_COOKIE = "imp_gate";

function normalizePassword(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

function passwordMatches(candidate: string, expected: string): boolean {
  const leftRaw = normalizePassword(candidate);
  const rightRaw = normalizePassword(expected);
  if (!leftRaw || !rightRaw) return false;
  const left = crypto.createHash("sha256").update(leftRaw, "utf8").digest();
  const right = crypto.createHash("sha256").update(rightRaw, "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

function passwordFingerprint(value: string): string {
  return crypto.createHash("sha256").update(normalizePassword(value), "utf8").digest("hex").slice(0, 8);
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

function signGateToken(expiresAt: number): string {
  const payload = String(expiresAt);
  const sig = crypto
    .createHmac("sha256", config.secretKey)
    .update(`site_gate:${payload}`)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function gateCookieValid(req: Request): boolean {
  const token = readCookie(req, GATE_COOKIE);
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expected = crypto
    .createHmac("sha256", config.secretKey)
    .update(`site_gate:${payload}`)
    .digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function setGateCookie(res: Response): void {
  const expiresAt = Date.now() + GATE_TTL_MS;
  res.cookie(GATE_COOKIE, signGateToken(expiresAt), {
    maxAge: GATE_TTL_MS,
    httpOnly: true,
    sameSite: "lax",
    secure: config.isHttps,
    path: "/",
  });
}

function clearGateCookie(res: Response): void {
  res.clearCookie(GATE_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isHttps,
    path: "/",
  });
}

export function hasGateAccess(req: Request): boolean {
  return Boolean(req.session?.site_gate) || gateCookieValid(req);
}

function renderGate(res: Response, error = ""): void {
  applyNoStore(res);
  res.status(error ? 401 : 200).render("gate.html", {
    app_name: config.appName,
    error,
  });
}

/** Trasy, ktore omijaja bramke haslem (health + same logowanie do bramki). */
function isGateExempt(req: Request): boolean {
  const path = req.path || "/";
  return (
    path === "/healthz" ||
    path.startsWith("/static/") ||
    path === "/gate" ||
    path === "/gate/login" ||
    path === "/gate/logout"
  );
}

export const siteGate: RequestHandler = (req, res, next) => {
  if (!getSiteGatePassword()) return next();
  if (isGateExempt(req)) return next();
  if (hasGateAccess(req)) {
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

export async function handleGateLogin(req: Request, res: Response): Promise<void> {
  const expected = getSiteGatePassword();
  if (!expected) {
    res.redirect(303, "/");
    return;
  }

  const body = req.body as Record<string, unknown> | undefined;
  const password = typeof body?.password === "string" ? body.password : "";
  const got = normalizePassword(password);

  if (!got) {
    console.warn(
      `Gate login: puste haslo w body (keys=${body ? Object.keys(body).join(",") : "no-body"} content-type=${req.headers["content-type"] || "-"})`,
    );
    renderGate(res, "Nieprawidlowe haslo.");
    return;
  }

  if (!passwordMatches(got, expected)) {
    console.warn(
      `Gate login fail: got_len=${got.length} exp_len=${expected.length} ` +
        `got_fp=${passwordFingerprint(got)} exp_fp=${passwordFingerprint(expected)} ` +
        `exp_last_code=${expected.charCodeAt(expected.length - 1)}`,
    );
    renderGate(res, "Nieprawidlowe haslo.");
    return;
  }

  req.session.site_gate = true;
  setGateCookie(res);
  await saveSession(req);
  const nextUrl =
    typeof body?.next === "string" && body.next.startsWith("/") && !body.next.startsWith("//")
      ? body.next
      : "/";
  applyNoStore(res);
  res.redirect(303, nextUrl);
}

export async function handleGateLogout(req: Request, res: Response, _next: NextFunction): Promise<void> {
  delete req.session.site_gate;
  clearGateCookie(res);
  await saveSession(req);
  applyNoStore(res);
  res.redirect(303, "/gate");
}

export function siteGateHealth(): { enabled: boolean; len: number; fp: string } {
  const password = getSiteGatePassword();
  return {
    enabled: Boolean(password),
    len: password.length,
    fp: password ? passwordFingerprint(password) : "",
  };
}
