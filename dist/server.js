"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
function assertProductionConfig() {
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
    // Na Hostingerze PORT jest wstrzykiwany automatycznie - bez niego i tak
    // polecimy na 8006, ktorego proxy nie zna, i dostaniemy 503.
    if (config_1.config.isHttps && !process.env["PORT"]) {
        console.warn("Uwaga: brak zmiennej PORT. Hostinger powinien ja ustawic sam. " +
            "Jesli jej nie ma, proxy nie trafi w proces.");
    }
    if (config_1.config.isHttps && missing.length > 0) {
        throw new Error(`Brak wymaganych zmiennych srodowiskowych w hPanel: ${missing.join(", ")}. ` +
            "Websites → Twoja strona → Environment variables.");
    }
}
async function main() {
    console.log(`Start ${config_1.config.appName}: PORT=${config_1.config.port} BASE_URL=${config_1.config.baseUrl} ` +
        `DB=${config_1.config.db.user}@${config_1.config.db.host}:${config_1.config.db.port}/${config_1.config.db.database}`);
    console.log(`Env: PORT=${process.env["PORT"] ? "set" : "MISSING"} ` +
        `DB_HOST=${process.env["DB_HOST"] ? "set" : "MISSING"} ` +
        `DB_USER=${process.env["DB_USER"] ? "set" : "MISSING"} ` +
        `DB_NAME=${process.env["DB_NAME"] ? "set" : "MISSING"} ` +
        `DB_PASSWORD=${process.env["DB_PASSWORD"] ? "set" : "MISSING"} ` +
        `SECRET_KEY=${process.env["SECRET_KEY"] ? "set" : "MISSING"} ` +
        `BASE_URL=${process.env["BASE_URL"] ? "set" : "MISSING"}`);
    assertProductionConfig();
    try {
        await (0, db_1.pingDatabase)();
        console.log("Polaczenie z MySQL OK.");
        await (0, migrate_1.migrate)();
        console.log("Migracja schematu MySQL OK.");
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error("Nie moge polaczyc sie z MySQL / utworzyc tabel:", reason);
        console.error("W hPanel → Environment variables ustaw DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME " +
            "dokladnie jak w Databases → MySQL (z prefixem uXXXX_). Potem Redeploy.");
        throw error;
    }
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
    app.get("/healthz", (_req, res) => {
        res.json({ status: "ok", app: config_1.config.appName, version: "1.0.0" });
    });
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
    // Hostinger w docsach Express pokazuje wylacznie listen(port) - bez hosta.
    // Podanie HOST=0.0.0.0 czasem psuje ich proxy i daje 503 mimo zywego procesu.
    const port = config_1.config.port;
    const server = app.listen(port, () => {
        console.log(`${config_1.config.appName} nasluchuje na porcie ${port} (BASE_URL=${config_1.config.baseUrl})`);
        if (!config_1.config.googleConfigured) {
            console.warn("Brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET - logowanie bedzie niedostepne.");
        }
    });
    const shutdown = async (signal) => {
        console.log(`Otrzymano ${signal}, zamykam...`);
        await (0, scheduler_1.shutdownScheduler)();
        server.close(async () => {
            await (0, db_1.closeDatabase)();
            process.exit(0);
        });
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
main().catch((error) => {
    console.error("Nie udalo sie uruchomic aplikacji:", error);
    process.exit(1);
});
//# sourceMappingURL=server.js.map