import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "../config.js";
import { db } from "../db/index.js";
import type { FlashMessage } from "../types.js";
import { createDefaultWorkspace } from "../services/workspaces.js";

export function flash(req: Request, message: string, category: FlashMessage["category"] = "success"): void {
  const messages = req.session._flashes ?? [];
  messages.push({ message, category });
  // Trzymamy tylko ostatnie piec, zeby ciasteczko sesji nie rosło bez konca.
  req.session._flashes = messages.slice(-5);
}

export function popFlashes(req: Request): FlashMessage[] {
  const messages = req.session?._flashes ?? [];
  if (req.session) req.session._flashes = [];
  return messages;
}

/** Naglowki, ktorych Hostinger hcdn respektuje przy private content. */
export function applyNoStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Vary", "Cookie");
}

/** Zapis sesji w MySQL MUSI sie skonczyc przed redirectem. */
export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!req.session) {
      resolve();
      return;
    }
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

export async function redirectWithSession(req: Request, res: Response, location: string): Promise<void> {
  await saveSession(req);
  applyNoStore(res);
  res.redirect(303, location);
}

/**
 * Pokazuje login jako 200 (BEZ Location).
 * Redirecty auth na Hostingerze CDN potrafi cache'owac i robic ERR_TOO_MANY_REDIRECTS.
 */
export function renderLoginPage(req: Request, res: Response, nextPath = "/"): void {
  applyNoStore(res);
  const safeNext =
    nextPath.startsWith("/") && !nextPath.startsWith("//") && !nextPath.startsWith("/login")
      ? nextPath
      : "/";
  res.status(200).render("login.html", {
    flashes: popFlashes(req),
    google_configured: config.googleConfigured,
    redirect_uri: config.redirectUri,
    next: safeNext,
  });
}

/**
 * Express nie ma odpowiednika `Depends` z FastAPI, wiec obsluga bledow
 * w handlerach async wymaga opakowania - bez tego odrzucona obietnica
 * konczy sie zawieszonym zadaniem, a nie strona bledu.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

export const loadUser: RequestHandler = asyncHandler(async (req, _res, next) => {
  const userId = req.session?.user_id;
  if (!userId) return next();

  const user = await db.selectFrom("users").selectAll().where("id", "=", Number(userId)).executeTakeFirst();
  if (!user || !user.is_active) {
    delete req.session.user_id;
    delete req.session.workspace_id;
    return next();
  }
  req.user = user;
  next();
});

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.user) return next();

  // API — JSON, bez redirectow.
  if (req.path.startsWith("/api/") || req.originalUrl.startsWith("/api/")) {
    applyNoStore(res);
    res.status(401).json({ detail: "Not authenticated" });
    return;
  }

  // POST/PUT/... — jeden 303 do /login (formularze). GET — render 200 w miejscu.
  if (req.method !== "GET" && req.method !== "HEAD") {
    applyNoStore(res);
    res.redirect(303, "/login");
    return;
  }

  const pathOnly = (req.originalUrl || "/").split("?")[0] ?? "/";
  const nextPath = pathOnly === "/" || pathOnly === "/login" ? "/" : req.originalUrl;
  renderLoginPage(req, res, nextPath);
};

export const requireApiAuth: RequestHandler = (req, res, next) => {
  if (req.user) return next();
  applyNoStore(res);
  res.status(401).json({ detail: "Not authenticated" });
};

/** Ustala aktywny workspace, tworzac domyslny przy pierwszym wejsciu. */
export const resolveWorkspace: RequestHandler = asyncHandler(async (req, _res, next) => {
  const user = req.user;
  if (!user) return next();

  let workspace;
  if (req.session.workspace_id) {
    workspace = await db
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", req.session.workspace_id)
      .where("user_id", "=", user.id)
      .executeTakeFirst();
  }
  if (!workspace) {
    workspace = await db
      .selectFrom("workspaces")
      .selectAll()
      .where("user_id", "=", user.id)
      .orderBy("id")
      .executeTakeFirst();
  }
  if (!workspace) {
    workspace = await createDefaultWorkspace(user);
  }

  req.session.workspace_id = workspace.id;
  req.workspace = workspace;
  next();
});

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function requireSite(req: Request, siteId: number) {
  const workspace = req.workspace;
  if (!workspace) throw new HttpError(500, "Brak kontekstu workspace.");
  const site = await db
    .selectFrom("sites")
    .selectAll()
    .where("id", "=", siteId)
    .where("workspace_id", "=", workspace.id)
    .executeTakeFirst();
  if (!site) throw new HttpError(404, "Nie znaleziono strony");
  return site;
}
