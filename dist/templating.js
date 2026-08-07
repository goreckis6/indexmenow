"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fmtDatetime = fmtDatetime;
exports.fmtRelative = fmtRelative;
exports.fmtNumber = fmtNumber;
exports.truncateUrl = truncateUrl;
exports.configureTemplates = configureTemplates;
exports.baseContext = baseContext;
const node_path_1 = __importDefault(require("node:path"));
const nunjucks_1 = __importDefault(require("nunjucks"));
const config_1 = require("./config");
const auth_1 = require("./middleware/auth");
const STATUS_LABELS = {
    INDEXED: "Zaindeksowany",
    NOT_INDEXED: "Niezaindeksowany",
    EXCLUDED: "Wykluczony",
    UNKNOWN: "Nieznany",
    ERROR: "Blad",
    PENDING: "Oczekuje",
    RUNNING: "W trakcie",
    SUCCESS: "Sukces",
    FAILED: "Blad",
    SKIPPED: "Pominiety",
};
const STATUS_TONES = {
    INDEXED: "ok",
    SUCCESS: "ok",
    NOT_INDEXED: "warn",
    PENDING: "warn",
    RUNNING: "info",
    EXCLUDED: "muted",
    SKIPPED: "muted",
    UNKNOWN: "muted",
    ERROR: "bad",
    FAILED: "bad",
};
const JOB_TYPE_LABELS = {
    URL_UPDATED: "Zgloszenie URL",
    URL_DELETED: "Usuniecie URL",
    INSPECT: "Inspekcja",
    SITEMAP_SUBMIT: "Zgloszenie sitemapy",
    SITEMAP_DELETE: "Usuniecie sitemapy",
    INDEXNOW: "IndexNow",
};
function pad(value) {
    return String(value).padStart(2, "0");
}
function fmtDatetime(value) {
    if (!value)
        return "—";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        return "—";
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function fmtRelative(value) {
    if (!value)
        return "nigdy";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        return "nigdy";
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 0)
        return "za chwile";
    if (seconds < 60)
        return "przed chwila";
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)} min temu`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)} godz. temu`;
    const days = Math.floor(seconds / 86400);
    if (days === 1)
        return "wczoraj";
    if (days < 30)
        return `${days} dni temu`;
    const months = Math.floor(days / 30);
    return months < 12 ? `${months} mies. temu` : `${Math.floor(days / 365)} lat temu`;
}
function fmtNumber(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return String(value ?? "—");
    // Spacja jako separator tysiecy, jak w polskiej konwencji.
    return Math.trunc(parsed).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function truncateUrl(value, length = 60) {
    if (!value)
        return "—";
    const cleaned = value.replace(/^https?:\/\//, "");
    return cleaned.length <= length ? cleaned : `${cleaned.slice(0, length - 1)}…`;
}
function configureTemplates(app) {
    const env = nunjucks_1.default.configure(node_path_1.default.join(config_1.ROOT_DIR, "views"), {
        autoescape: true,
        express: app,
        noCache: config_1.config.debug,
    });
    env.addFilter("dt", fmtDatetime);
    env.addFilter("ago", fmtRelative);
    env.addFilter("num", fmtNumber);
    env.addFilter("short_url", truncateUrl);
    env.addFilter("status_label", (value) => STATUS_LABELS[String(value)] ?? String(value ?? "—"));
    env.addFilter("status_tone", (value) => STATUS_TONES[String(value)] ?? "muted");
    env.addFilter("job_type", (value) => JOB_TYPE_LABELS[String(value)] ?? String(value ?? "—"));
    // Jinja2 ma |map(attribute="x")|list, Nunjucks nie - wykresy w szablonach
    // wyciagaja tym jedna kolumne z listy obiektow.
    env.addFilter("attr_list", (rows, attribute) => {
        if (!Array.isArray(rows))
            return [];
        return rows.map((row) => row?.[attribute] ?? null);
    });
    // Odpowiednik |tojson z Jinja2. Nunjucks ma |dump, ale nie escapuje znakow,
    // ktore zamknelyby atrybut HTML, w ktorym te dane siedza.
    env.addFilter("tojson", (value) => {
        const json = JSON.stringify(value ?? null);
        return new nunjucks_1.default.runtime.SafeString(json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/'/g, "\\u0027"));
    });
    // Jinja2 ma |min/|max na listach oraz '%02d'|format(...) - w Nunjucks nie ma
    // zadnego z nich, a szablony z nich korzystaja.
    env.addFilter("min", (rows) => (Array.isArray(rows) ? Math.min(...rows.map(Number)) : rows));
    env.addFilter("max", (rows) => (Array.isArray(rows) ? Math.max(...rows.map(Number)) : rows));
    env.addFilter("pad2", (value) => pad(Number(value) || 0));
    // Jinja2 ma |round i |int; Nunjucks nie - bez nich szablony z pokryciem i ms padaja.
    env.addFilter("round", (value, precision = 0) => {
        const n = Number(value);
        if (!Number.isFinite(n))
            return value;
        const factor = 10 ** Number(precision);
        return Math.round(n * factor) / factor;
    });
    env.addFilter("int", (value) => {
        const n = Number.parseInt(String(value), 10);
        return Number.isFinite(n) ? n : 0;
    });
    env.addFilter("upper", (value) => String(value ?? "").toUpperCase());
    env.addGlobal("app_name", config_1.config.appName);
    env.addGlobal("now", () => new Date());
    return env;
}
/** Adres bazy do wyswietlenia w panelu - bez hasla. */
function maskedDatabaseUrl() {
    const { user, host, port, database } = config_1.config.db;
    return `mysql://${user}@${host}:${port}/${database}`;
}
/** Wspolny kontekst dla kazdej strony - odpowiednik render() z wersji Pythona. */
function baseContext(req, context = {}) {
    return {
        flashes: (0, auth_1.popFlashes)(req),
        app_settings: {
            app_name: config_1.config.appName,
            base_url: config_1.config.baseUrl,
            host: config_1.config.host,
            port: config_1.config.port,
            database_url: maskedDatabaseUrl(),
            google_configured: config_1.config.googleConfigured,
            timezone: config_1.config.timezone,
            default_daily_quota: config_1.config.defaultDailyQuota,
            auto_index_hour: config_1.config.autoIndexHour,
            sitemap_scan_interval_hours: config_1.config.sitemapScanIntervalHours,
            recheck_after_days: config_1.config.recheckAfterDays,
            inspection_batch_size: config_1.config.inspectionBatchSize,
        },
        user: req.user ?? null,
        workspace: req.workspace ?? null,
        request: { path: req.path, query: req.query, url: req.originalUrl },
        ...context,
    };
}
//# sourceMappingURL=templating.js.map