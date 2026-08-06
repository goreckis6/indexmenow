import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

export const ROOT_DIR = path.resolve(__dirname, "..");

function str(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function int(name: string, fallback: number): number {
  const parsed = Number.parseInt(str(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function float(name: string, fallback: number): number {
  const parsed = Number.parseFloat(str(name));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = str(name).toLowerCase();
  if (value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

/**
 * Hostinger udostepnia dane MySQL pod roznymi nazwami zaleznie od miejsca,
 * w ktorym sie je konfiguruje. Przyjmujemy jedno i drugie, zeby nie zmuszac
 * do przepisywania wartosci recznie.
 */
function databaseConfig() {
  const url = str("DATABASE_URL");
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`DATABASE_URL nie jest poprawnym adresem: ${url}`);
    }
    // Bez tej kontroli adres w innym formacie (np. zostawiony sqlite:///...)
    // rozlozylby sie na puste pola i aplikacja probowalaby sie łączyć
    // z localhost jako root, zamiast zglosic blad konfiguracji.
    if (!["mysql:", "mariadb:"].includes(parsed.protocol)) {
      throw new Error(
        `DATABASE_URL musi wskazywac na MySQL (mysql://...), a wskazuje na "${parsed.protocol}//". ` +
          "Ta wersja panelu dziala tylko na MySQL.",
      );
    }
    const database = parsed.pathname.replace(/^\//, "");
    if (!database) {
      throw new Error("DATABASE_URL nie zawiera nazwy bazy danych (czesc po ostatnim /).");
    }
    return {
      host: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database,
    };
  }
  return {
    host: str("DB_HOST", str("MYSQL_HOST", "localhost")),
    port: int("DB_PORT", int("MYSQL_PORT", 3306)),
    user: str("DB_USER", str("MYSQL_USER", "root")),
    password: str("DB_PASSWORD", str("MYSQL_PASSWORD", "")),
    database: str("DB_NAME", str("MYSQL_DATABASE", "indexmenow")),
  };
}

const baseUrl = str("BASE_URL", "http://localhost:8006").replace(/\/+$/, "");
const secretKey = str("SECRET_KEY", "insecure-dev-key-change-me");

export const config = {
  appName: "IndexMeNow",
  host: str("HOST", "0.0.0.0"),
  port: int("PORT", 8006),
  baseUrl,
  secretKey,
  debug: bool("DEBUG", false),
  logLevel: str("LOG_LEVEL", "INFO"),
  timezone: str("TIMEZONE", "Europe/Warsaw"),

  googleClientId: str("GOOGLE_CLIENT_ID"),
  googleClientSecret: str("GOOGLE_CLIENT_SECRET"),
  allowedEmails: str("ALLOWED_EMAILS"),

  db: databaseConfig(),

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

  get redirectUri(): string {
    return `${baseUrl}/auth/callback`;
  },

  get isHttps(): boolean {
    return baseUrl.startsWith("https://");
  },

  get allowedEmailList(): string[] {
    return this.allowedEmails
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },

  get googleConfigured(): boolean {
    return Boolean(this.googleClientId && this.googleClientSecret);
  },

  /** Klucz AES-256 wyprowadzony z SECRET_KEY - tak samo jak w wersji Pythona. */
  get encryptionKey(): Buffer {
    return crypto.createHash("sha256").update(secretKey, "utf8").digest();
  },
};

export type AppConfig = typeof config;
