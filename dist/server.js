"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startFromBootloader = startFromBootloader;
const node_path_1 = __importDefault(require("node:path"));
const express_1 = __importDefault(require("express"));
const express_session_1 = __importDefault(require("express-session"));
const express_mysql_session_1 = __importDefault(require("express-mysql-session"));
const multer_1 = __importDefault(require("multer"));
const config_1 = require("./config");
const db_1 = require("./db");
const migrate_1 = require("./db/migrate");
const auth_1 = require("./middleware/auth");
const api_1 = require("./routes/api");
const auth_2 = require("./routes/auth");
const dashboard_1 = require("./routes/dashboard");
const history_1 = require("./routes/history");
const settings_1 = require("./routes/settings");
const sites_1 = require("./routes/sites");
const tools_1 = require("./routes/tools");
const urls_1 = require("./routes/urls");
const scheduler_1 = require("./services/scheduler");
const templating_1 = require("./templating");
require("./types");
const MySQLStore = (0, express_mysql_session_1.default)(express_session_1.default);
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
    const app = (0, express_1.default)();
    app.set("trust proxy", 1);
    app.get("/healthz", (_req, res) => {
        res.status(503).json({
            status: "misconfigured",
            app: config_1.config.appName,
            port: config_1.config.port,
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
    const app = (0, express_1.default)();
    app.set("trust proxy", 1);
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
    }, db_1.pool);
    app.use((0, express_session_1.default)({
        name: "imp_session",
        secret: config_1.config.secretKey,
        resave: false,
        saveUninitialized: false,
        store: sessionStore,
        cookie: {
            maxAge: 30 * 24 * 60 * 60 * 1000,
            sameSite: "lax",
            secure: config_1.config.isHttps,
            httpOnly: true,
        },
    }));
    app.use(express_1.default.urlencoded({ extended: true, limit: "2mb" }));
    app.use(express_1.default.json({ limit: "1mb" }));
    app.use("/static", express_1.default.static(node_path_1.default.join(config_1.ROOT_DIR, "public"), { maxAge: "1d" }));
    // Przed sesja / auth — Hostinger i monitoring musza trafic w zywy JSON.
    app.get("/healthz", (_req, res) => {
        res.json({ status: "ok", app: config_1.config.appName, version: "1.0.0" });
    });
    (0, templating_1.configureTemplates)(app);
    app.use(auth_1.loadUser);
    const upload = (0, multer_1.default)({
        storage: multer_1.default.memoryStorage(),
        limits: { fileSize: 2 * 1024 * 1024 },
    });
    app.use("/urls/add", upload.single("file"));
    app.use("/settings/service-account", upload.single("file"));
    app.use(auth_2.authRouter);
    app.use(dashboard_1.dashboardRouter);
    app.use("/sites", sites_1.sitesRouter);
    app.use("/urls", urls_1.urlsRouter);
    app.use("/history", history_1.historyRouter);
    app.use("/settings", settings_1.settingsRouter);
    app.use("/tools", tools_1.toolsRouter);
    app.use("/api", api_1.apiRouter);
    app.use((err, req, res, _next) => {
        const status = err instanceof auth_1.HttpError ? err.status : 500;
        const detail = err instanceof auth_1.HttpError
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
            res.status(404).render("errors/404.html", (0, templating_1.baseContext)(req));
            return;
        }
        res.status(status).render("errors/generic.html", (0, templating_1.baseContext)(req, { status_code: status, detail }));
    });
    app.use((req, res) => {
        if (req.path.startsWith("/api/")) {
            res.status(404).json({ detail: "Nie znaleziono" });
            return;
        }
        res.status(404).render("errors/404.html", (0, templating_1.baseContext)(req));
    });
    await (0, scheduler_1.startScheduler)();
    if (!config_1.config.googleConfigured) {
        console.warn("Brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET - logowanie bedzie niedostepne.");
    }
    return app;
}
/**
 * Buduje aplikacje Express BEZ listen().
 * Uzywane przez rootowy server.js (bootloader Hostingera).
 */
async function startFromBootloader() {
    console.log(`Start ${config_1.config.appName}: PORT=${config_1.config.port} BASE_URL=${config_1.config.baseUrl} ` +
        `DB=${config_1.config.db.user}@${config_1.config.db.host}:${config_1.config.db.port}/${config_1.config.db.database}`);
    console.log(envPresenceLine());
    if (config_1.config.dbConfigError) {
        console.error(config_1.config.dbConfigError);
        return buildDiagnosticApp(config_1.config.dbConfigError);
    }
    if (config_1.config.isHttps && !process.env["PORT"]) {
        console.warn("Uwaga: brak zmiennej PORT. Hostinger powinien ja ustawic sam. " +
            "Jesli jej nie ma, proxy nie trafi w proces i zobaczysz 503 CDN.");
    }
    const missing = collectMissingEnv();
    if (config_1.config.isHttps && missing.length > 0) {
        const reason = `Brak wymaganych zmiennych w hPanel: ${missing.join(", ")}. ` +
            "Websites → Twoja strona → Environment variables.";
        console.error(reason);
        return buildDiagnosticApp(reason);
    }
    try {
        await (0, db_1.pingDatabase)();
        console.log("Polaczenie z MySQL OK.");
        await (0, migrate_1.migrate)();
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
    const port = config_1.config.port;
    const server = app.listen(port, () => {
        console.log(`${config_1.config.appName} nasluchuje na porcie ${port} (BASE_URL=${config_1.config.baseUrl})`);
    });
    const shutdown = async (signal) => {
        console.log(`Otrzymano ${signal}, zamykam...`);
        await (0, scheduler_1.shutdownScheduler)().catch(() => undefined);
        server.close(async () => {
            await (0, db_1.closeDatabase)().catch(() => undefined);
            process.exit(0);
        });
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
// Uruchomienie bezposrednie: `node dist/server.js` / `tsx src/server.ts`
const isDirectRun = typeof require !== "undefined" &&
    typeof module !== "undefined" &&
    require.main === module;
if (isDirectRun) {
    listenDirectly().catch((error) => {
        console.error("Nie udalo sie uruchomic aplikacji:", error);
        process.exit(1);
    });
}
//# sourceMappingURL=server.js.map