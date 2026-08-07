import { db } from "../db/index.js";
import { createDefaultWorkspace } from "../services/workspaces.js";
export function flash(req, message, category = "success") {
    const messages = req.session._flashes ?? [];
    messages.push({ message, category });
    // Trzymamy tylko ostatnie piec, zeby ciasteczko sesji nie rosło bez konca.
    req.session._flashes = messages.slice(-5);
}
export function popFlashes(req) {
    const messages = req.session?._flashes ?? [];
    if (req.session)
        req.session._flashes = [];
    return messages;
}
/**
 * Express nie ma odpowiednika `Depends` z FastAPI, wiec obsluga bledow
 * w handlerach async wymaga opakowania - bez tego odrzucona obietnica
 * konczy sie zawieszonym zadaniem, a nie strona bledu.
 */
export function asyncHandler(fn) {
    return (req, res, next) => {
        void fn(req, res, next).catch(next);
    };
}
export const loadUser = asyncHandler(async (req, _res, next) => {
    const userId = req.session?.user_id;
    if (!userId)
        return next();
    const user = await db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
    if (!user || !user.is_active) {
        req.session.destroy(() => undefined);
        return next();
    }
    req.user = user;
    next();
});
export const requireAuth = (req, res, next) => {
    if (req.user)
        return next();
    const target = req.path === "/" || req.path === "/login" ? "/login" : `/login?next=${encodeURIComponent(req.originalUrl)}`;
    res.redirect(303, target);
};
export const requireApiAuth = (req, res, next) => {
    if (req.user)
        return next();
    res.status(401).json({ detail: "Not authenticated" });
};
/** Ustala aktywny workspace, tworzac domyslny przy pierwszym wejsciu. */
export const resolveWorkspace = asyncHandler(async (req, _res, next) => {
    const user = req.user;
    if (!user)
        return next();
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
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "HttpError";
    }
}
export async function requireSite(req, siteId) {
    const workspace = req.workspace;
    if (!workspace)
        throw new HttpError(500, "Brak kontekstu workspace.");
    const site = await db
        .selectFrom("sites")
        .selectAll()
        .where("id", "=", siteId)
        .where("workspace_id", "=", workspace.id)
        .executeTakeFirst();
    if (!site)
        throw new HttpError(404, "Nie znaleziono strony");
    return site;
}
//# sourceMappingURL=auth.js.map