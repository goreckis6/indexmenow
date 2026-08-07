import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";
import multer from "multer";
import { config, ROOT_DIR } from "./config.js";
import { closeDatabase, pingDatabase, pool } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { HttpError, loadUser } from "./middleware/auth.js";
import { apiRouter } from "./routes/api.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { historyRouter } from "./routes/history.js";
import { settingsRouter } from "./routes/settings.js";
import { sitesRouter } from "./routes/sites.js";
import { toolsRouter } from "./routes/tools.js";
import { urlsRouter } from "./routes/urls.js";
import { shutdownScheduler, startScheduler } from "./services/scheduler.js";
import { baseContext, configureTemplates } from "./templating.js";
import "./types.js";
const MySQLStore = MySQLStoreFactory(session);
function envPresenceLine() {
    return (`Env: PORT=${process.env["PORT"] ? "set" : "MISSING"} ` +
        `DB_HOST=${process.env["DB_HOST"] || process.env["MYSQL_HOST"] ? "set" : "MISSING"} ` +
        `DB_USER=${process.env["DB_USER"] || process.env["MYSQL_USER"] ? "set" : "MISSING"} ` +
        `DB_NAME=${process.env["DB_NAME"] || process.env["MYSQL_DATABASE"] ? "set" : "MISSING"} ` +
        `DB_PASSWORD=${process.env["DB_PASSWORD"] || process.env["MYSQL_PASSWORD"] ? "set" : "MISSING"} ` +
        `SECRET_KEY=${process.env["SECRET_KEY"] ? "set" : "MISSING"} ` +
        `BASE_URL=${process.env["BASE_URL"] ? "set" : "MISSING"}`);
}
function collectMissingEnv() {
    const missing = [];
    if (!process.env["DB_HOST"] && !process.env["DATABASE_URL"] && !process.env["MYSQL_HOST"]) {
        missing.push("DB_HOST (albo DATABASE_URL)");
    }
    if (!process.env["DB_USER"] && !process.env["DATABASE_URL"] && !process.env["MYSQL_USER"]) {
        missing.push("DB_USER");
    }
    if (!process.env["DB_NAME"] && !process.env["DATABASE_URL"] && !process.env["MYSQL_DATABASE"]) {
        missing.push("DB_NAME");
    }
    if (!process.env["DB_PASSWORD"] &&
        !process.env["DATABASE_URL"] &&
        !process.env["MYSQL_PASSWORD"]) {
        missing.push("DB_PASSWORD");
    }
    if (!process.env["SECRET_KEY"])
        missing.push("SECRET_KEY");
    if (!process.env["BASE_URL"])
        missing.push("BASE_URL");
    return missing;
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
function diagnosticHtml(reason) {
    return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>IndexMeNow — konfiguracja</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1.25rem;line-height:1.5;color:#111}
    code{background:#f3f3f3;padding:.1rem .35rem;border-radius:4px}
    pre{background:#111;color:#eee;padding:1rem;border-radius:8px;overflow:auto;white-space:pre-wrap}
  </style>
</head>
<body>
  <h1>IndexMeNow działa, ale nie jest gotowe</h1>
  <p>Proces Node nasłuchuje. Brakuje bazy / zmiennych:</p>
  <pre>${escapeHtml(reason)}</pre>
  <p>W hPanel → <strong>Environment variables</strong> ustaw:</p>
  <pre>BASE_URL=https://morphyhub.com
SECRET_KEY=&lt;losowy ciąg&gt;
DB_HOST=...
DB_PORT=3306
DB_USER=uXXXX_...
DB_PASSWORD=...
DB_NAME=uXXXX_...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ALLOWED_EMAILS=twoj@email.com</pre>
  <p>Dane MySQL z <strong>Databases → MySQL</strong>. Potem Redeploy / Restart.</p>
  <p><a href="/healthz">/healthz</a></p>
</body>
</html>`;
}
function buildDiagnosticApp(reason) {
    const app = express();
    app.set("trust proxy", 1);
    app.get("/healthz", (_req, res) => {
        res.status(503).json({
            status: "misconfigured",
            app: config.appName,
            port: config.port,
            error: reason,
            env: {
                PORT: Boolean(process.env["PORT"]),
                DB_HOST: Boolean(process.env["DB_HOST"] || process.env["MYSQL_HOST"]),
                DB_USER: Boolean(process.env["DB_USER"] || process.env["MYSQL_USER"]),
                DB_NAME: Boolean(process.env["DB_NAME"] || process.env["MYSQL_DATABASE"]),
                DB_PASSWORD: Boolean(process.env["DB_PASSWORD"] || process.env["MYSQL_PASSWORD"]),
                SECRET_KEY: Boolean(process.env["SECRET_KEY"]),
                BASE_URL: Boolean(process.env["BASE_URL"]),
            },
        });
    });
    app.use((_req, res) => {
        res.status(503).type("html").send(diagnosticHtml(reason));
    });
    return app;
}
async function buildFullApp() {
    const app = express();
    // CDN + reverse proxy Hostingera: bez tego cookie Secure / req.secure sa zle.
    app.set("trust proxy", true);
    // www czesto wskazuje na inne hosting (HTML), nie na ta apke Node — wtedy CSS
    // wraca jako text/html i strona jest "bez styli". Robimy kanoniczny redirect.
    app.use((req, res, next) => {
        const host = (req.hostname || "").toLowerCase();
        if (host.startsWith("www.")) {
            const target = new URL(req.originalUrl || "/", config.baseUrl);
            res.redirect(301, target.toString());
            return;
        }
        next();
    });
    // Static PRZED sesja — zero szans, ze auth/CDN-middleware ruszy CSS/JS.
    const publicDir = path.join(ROOT_DIR, "public");
    const publicDirCwd = path.join(process.cwd(), "public");
    app.use("/static", express.static(publicDir, { maxAge: "7d", fallthrough: true, index: false }));
    if (publicDirCwd !== publicDir) {
        app.use("/static", express.static(publicDirCwd, { maxAge: "7d", fallthrough: false, index: false }));
    }
    const sessionStore = new MySQLStore({
        clearExpired: true,
        checkExpirationInterval: 15 * 60 * 1000,
        expiration: 30 * 24 * 60 * 60 * 1000,
        createDatabaseTable: true,
        schema: {
            tableName: "sessions",
            columnNames: {
                session_id: "session_id",
                expires: "expires",
                data: "data",
            },
        },
    }, pool);
    app.use(session({
        name: "imp_session",
        secret: config.secretKey,
        resave: false,
        saveUninitialized: false,
        proxy: true,
        store: sessionStore,
        cookie: {
            maxAge: 30 * 24 * 60 * 60 * 1000,
            sameSite: "lax",
            secure: config.isHttps,
            httpOnly: true,
            path: "/",
        },
    }));
    // Hostinger hcdn cache'owal 303 auth i robil ERR_TOO_MANY_REDIRECTS.
    // Auth GET teraz serwuje login jako 200; tu dodatkowe naglowki na cala apke.
    app.use((req, res, next) => {
        if (req.path.startsWith("/static/"))
            return next();
        res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
        res.setHeader("CDN-Cache-Control", "no-store");
        res.setHeader("Surrogate-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("Vary", "Cookie");
        next();
    });
    app.use(express.urlencoded({ extended: true, limit: "2mb" }));
    app.use(express.json({ limit: "1mb" }));
    // Przed sesja / auth — Hostinger i monitoring musza trafic w zywy JSON.
    app.get("/healthz", (_req, res) => {
        res.json({ status: "ok", app: config.appName, version: "1.0.0" });
    });
    configureTemplates(app);
    app.use(loadUser);
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 2 * 1024 * 1024 },
    });
    app.use("/urls/add", upload.single("file"));
    app.use("/settings/service-account", upload.single("file"));
    app.use(authRouter);
    app.use(dashboardRouter);
    app.use("/sites", sitesRouter);
    app.use("/urls", urlsRouter);
    app.use("/history", historyRouter);
    app.use("/settings", settingsRouter);
    app.use("/tools", toolsRouter);
    app.use("/api", apiRouter);
    app.use((err, req, res, _next) => {
        const status = err instanceof HttpError ? err.status : 500;
        const detail = err instanceof HttpError
            ? err.message
            : err instanceof Error
                ? err.message
                : "Wewnetrzny blad serwera";
        if (status >= 500)
            console.error(err);
        if (req.path.startsWith("/api/") || status === 401) {
            res.status(status).json({ detail });
            return;
        }
        if (status === 404) {
            res.status(404).render("errors/404.html", baseContext(req));
            return;
        }
        res.status(status).render("errors/generic.html", baseContext(req, { status_code: status, detail }));
    });
    app.use((req, res) => {
        if (req.path.startsWith("/api/")) {
            res.status(404).json({ detail: "Nie znaleziono" });
            return;
        }
        res.status(404).render("errors/404.html", baseContext(req));
    });
    await startScheduler();
    if (!config.googleConfigured) {
        console.warn("Brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET - logowanie bedzie niedostepne.");
    }
    return app;
}
/**
 * Buduje aplikacje Express BEZ listen().
 * Uzywane przez rootowy server.js (bootloader Hostingera).
 */
export async function startFromBootloader() {
    console.log(`Start ${config.appName}: PORT=${config.port} BASE_URL=${config.baseUrl} ` +
        `DB=${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
    console.log(envPresenceLine());
    if (config.dbConfigError) {
        console.error(config.dbConfigError);
        return buildDiagnosticApp(config.dbConfigError);
    }
    if (config.isHttps && !process.env["PORT"]) {
        console.warn("Uwaga: brak zmiennej PORT. Hostinger powinien ja ustawic sam. " +
            "Jesli jej nie ma, proxy nie trafi w proces i zobaczysz 503 CDN.");
    }
    const missing = collectMissingEnv();
    if (config.isHttps && missing.length > 0) {
        const reason = `Brak wymaganych zmiennych w hPanel: ${missing.join(", ")}. ` +
            "Websites → Twoja strona → Environment variables.";
        console.error(reason);
        return buildDiagnosticApp(reason);
    }
    try {
        await pingDatabase();
        console.log("Polaczenie z MySQL OK.");
        await migrate();
        console.log("Migracja schematu MySQL OK.");
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error("Nie moge polaczyc sie z MySQL / utworzyc tabel:", reason);
        return buildDiagnosticApp(reason);
    }
    return buildFullApp();
}
async function listenDirectly() {
    const app = await startFromBootloader();
    const port = config.port;
    const server = app.listen(port, () => {
        console.log(`${config.appName} nasluchuje na porcie ${port} (BASE_URL=${config.baseUrl})`);
    });
    const shutdown = async (signal) => {
        console.log(`Otrzymano ${signal}, zamykam...`);
        await shutdownScheduler().catch(() => undefined);
        server.close(async () => {
            await closeDatabase().catch(() => undefined);
            process.exit(0);
        });
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
// Uruchomienie bezposrednie: `node dist/server.js`
const isDirectRun = process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
if (isDirectRun) {
    listenDirectly().catch((error) => {
        console.error("Nie udalo sie uruchomic aplikacji:", error);
        process.exit(1);
    });
}
//# sourceMappingURL=server.js.map