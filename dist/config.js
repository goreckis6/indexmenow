"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = exports.ROOT_DIR = void 0;
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.ROOT_DIR = node_path_1.default.resolve(__dirname, "..");
function str(name, fallback = "") {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
}
function int(name, fallback) {
    const parsed = Number.parseInt(str(name), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function float(name, fallback) {
    const parsed = Number.parseFloat(str(name));
    return Number.isFinite(parsed) ? parsed : fallback;
}
function bool(name, fallback) {
    const value = str(name).toLowerCase();
    if (value === "")
        return fallback;
    return ["1", "true", "yes", "on"].includes(value);
}
/**
 * Hostinger udostepnia dane MySQL pod roznymi nazwami zaleznie od miejsca,
 * w ktorym sie je konfiguruje. Przyjmujemy jedno i drugie, zeby nie zmuszac
 * do przepisywania wartosci recznie.
 *
 * Blad parsowania NIE rzuca przy imporcie modulu — inaczej bootloader
 * nie zdazy zrobic listen() i Hostinger pokazuje 503 CDN.
 */
function databaseConfig() {
    const url = str("DATABASE_URL");
    if (url) {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            return {
                db: {
                    host: "localhost",
                    port: 3306,
                    user: "root",
                    password: "",
                    database: "indexmenow",
                },
                error: `DATABASE_URL nie jest poprawnym adresem: ${url}`,
            };
        }
        if (!["mysql:", "mariadb:"].includes(parsed.protocol)) {
            return {
                db: {
                    host: "localhost",
                    port: 3306,
                    user: "root",
                    password: "",
                    database: "indexmenow",
                },
                error: `DATABASE_URL musi wskazywac na MySQL (mysql://...), a wskazuje na "${parsed.protocol}//". ` +
                    "Usun DATABASE_URL z hPanel albo ustaw mysql://... — ta wersja dziala tylko na MySQL.",
            };
        }
        const database = parsed.pathname.replace(/^\//, "");
        if (!database) {
            return {
                db: {
                    host: parsed.hostname || "localhost",
                    port: parsed.port ? Number.parseInt(parsed.port, 10) : 3306,
                    user: decodeURIComponent(parsed.username || "root"),
                    password: decodeURIComponent(parsed.password || ""),
                    database: "indexmenow",
                },
                error: "DATABASE_URL nie zawiera nazwy bazy danych (czesc po ostatnim /).",
            };
        }
        return {
            db: {
                host: parsed.hostname,
                port: parsed.port ? Number.parseInt(parsed.port, 10) : 3306,
                user: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password),
                database,
            },
            error: null,
        };
    }
    return {
        db: {
            host: str("DB_HOST", str("MYSQL_HOST", "localhost")),
            port: int("DB_PORT", int("MYSQL_PORT", 3306)),
            user: str("DB_USER", str("MYSQL_USER", "root")),
            password: str("DB_PASSWORD", str("MYSQL_PASSWORD", "")),
            database: str("DB_NAME", str("MYSQL_DATABASE", "indexmenow")),
        },
        error: null,
    };
}
const baseUrl = str("BASE_URL", "http://localhost:8006").replace(/\/+$/, "");
const secretKey = str("SECRET_KEY", "insecure-dev-key-change-me");
const resolvedDb = databaseConfig();
exports.config = {
    appName: "IndexMeNow",
    host: str("HOST", "0.0.0.0"),
    // Hostinger wstrzykuje PORT. Fallback 3000 jak w ich docsach Express
    // (lokalnie nadpisujesz PORT=8006 w .env).
    port: int("PORT", 3000),
    baseUrl,
    secretKey,
    debug: bool("DEBUG", false),
    logLevel: str("LOG_LEVEL", "INFO"),
    timezone: str("TIMEZONE", "Europe/Warsaw"),
    googleClientId: str("GOOGLE_CLIENT_ID"),
    googleClientSecret: str("GOOGLE_CLIENT_SECRET"),
    allowedEmails: str("ALLOWED_EMAILS"),
    db: resolvedDb.db,
    /** Blad konfiguracji DB z chwili importu (np. sqlite:// w DATABASE_URL). */
    dbConfigError: resolvedDb.error,
    defaultDailyQuota: int("DEFAULT_DAILY_QUOTA", 200),
    sitemapScanIntervalHours: int("SITEMAP_SCAN_INTERVAL_HOURS", 12),
    autoIndexHour: int("AUTO_INDEX_HOUR", 3),
    inspectionBatchSize: int("INSPECTION_BATCH_SIZE", 50),
    apiThrottleSeconds: float("API_THROTTLE_SECONDS", 0.6),
    recheckAfterDays: int("RECHECK_AFTER_DAYS", 7),
    /**
     * Zarzadzany hosting potrafi trzymac kilka instancji aplikacji naraz.
     * Scheduler moze dzialac tylko w jednej, inaczej te same URL-e polecialyby
     * do Google wielokrotnie i wypalily dzienny limit.
     */
    schedulerEnabled: bool("SCHEDULER_ENABLED", true),
    get redirectUri() {
        return `${baseUrl}/auth/callback`;
    },
    get isHttps() {
        return baseUrl.startsWith("https://");
    },
    get allowedEmailList() {
        return this.allowedEmails
            .split(",")
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean);
    },
    get googleConfigured() {
        return Boolean(this.googleClientId && this.googleClientSecret);
    },
    /** Klucz AES-256 wyprowadzony z SECRET_KEY - tak samo jak w wersji Pythona. */
    get encryptionKey() {
        return node_crypto_1.default.createHash("sha256").update(secretKey, "utf8").digest();
    },
};
//# sourceMappingURL=config.js.map