import type { NextFunction, Request, RequestHandler, Response } from "express";
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

/** Zapis sesji w MySQL MUSI sie skonczyc przed redirectem — inaczej Hostinger gubi cookie i petla / ↔ /login. */
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
  res.redirect(303, location);
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
  // Unikaj /login?next=/login?... (petla w Location)
  const pathOnly = (req.originalUrl || req.path || "/").split("?")[0] ?? "/";
  if (pathOnly === "/" || pathOnly === "/login") {
    res.redirect(303, "/login");
    return;
  }
  res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
};

export const requireApiAuth: RequestHandler = (req, res, next) => {
  if (req.user) return next();
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
