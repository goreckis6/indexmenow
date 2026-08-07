import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "..");

function str(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

/** Hasla z env: trim + zdejmij cudzyslowy (hPanel czasem zapisuje je doslownie). */
export function normalizeSecret(raw: string | undefined | null): string {
  let value = (raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim();
  }
  // Hostinger / panele czasem trzymaja MalinA666%23 zamiast MalinA666#
  if (value.includes("%")) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded) value = decoded;
    } catch {
      /* zostaw surowe */
    }
  }
  return value;
}

function secretStr(name: string, fallback = ""): string {
  return normalizeSecret(str(name, fallback));
}

/**
 * Haslo bramki — czytane na zywo z process.env (po restarcie hPanel bez redeployu).
 * Preferuj SITE_GATE_PASSWORD_B64 (base64), gdy zwykle haslo psuje sie przez znak #.
 */
export function getSiteGatePassword(): string {
  const b64 = str("SITE_GATE_PASSWORD_B64").trim();
  if (b64) {
    try {
      return normalizeSecret(Buffer.from(b64, "base64").toString("utf8"));
    } catch {
      /* fall through */
    }
  }
  return normalizeSecret(process.env["SITE_GATE_PASSWORD"]);
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

export type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

/**
 * Na Hostingerze `localhost` czesto rozwija sie do IPv6 `::1`, a konto MySQL
 * ma grant tylko dla `127.0.0.1` / `localhost` (IPv4) — wtedy: Access denied
 * for user 'uXXXX'@'::1'. Wymuszamy IPv4.
 */
function normalizeDbHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed || trimmed === "localhost" || trimmed === "::1") {
    return "127.0.0.1";
  }
  return trimmed;
}

/**
 * Hostinger udostepnia dane MySQL pod roznymi nazwami zaleznie od miejsca,
 * w ktorym sie je konfiguruje. Przyjmujemy jedno i drugie, zeby nie zmuszac
 * do przepisywania wartosci recznie.
 *
 * Blad parsowania NIE rzuca przy imporcie modulu — inaczej bootloader
 * nie zdazy zrobic listen() i Hostinger pokazuje 503 CDN.
 */
function databaseConfig(): { db: DbConfig; error: string | null } {
  const url = str("DATABASE_URL");
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        db: {
          host: "127.0.0.1",
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
          host: "127.0.0.1",
          port: 3306,
          user: "root",
          password: "",
          database: "indexmenow",
        },
        error:
          `DATABASE_URL musi wskazywac na MySQL (mysql://...), a wskazuje na "${parsed.protocol}//". ` +
          "Usun DATABASE_URL z hPanel albo ustaw mysql://... — ta wersja dziala tylko na MySQL.",
      };
    }
    const database = parsed.pathname.replace(/^\//, "");
    if (!database) {
      return {
        db: {
          host: normalizeDbHost(parsed.hostname || "127.0.0.1"),
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
        host: normalizeDbHost(parsed.hostname),
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
      host: normalizeDbHost(str("DB_HOST", str("MYSQL_HOST", "127.0.0.1"))),
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

export const config = {
  appName: "IndexMeNow",
  host: str("HOST", "0.0.0.0"),
  // Hostinger wstrzykuje PORT. Fallback 3000 jak w ich docsach Express
  // (lokalnie nadpisujesz PORT=8006 w .env).
  port: int("PORT", 3000),
  baseUrl,
  secretKey,
  /** Query ?v= na CSS/JS — bust cache CDN po deployu. */
  assetVersion: str("ASSET_VERSION", "20260807e"),
  debug: bool("DEBUG", false),
  logLevel: str("LOG_LEVEL", "INFO"),
  timezone: str("TIMEZONE", "Europe/Warsaw"),

  googleClientId: str("GOOGLE_CLIENT_ID"),
  googleClientSecret: str("GOOGLE_CLIENT_SECRET"),
  allowedEmails: str("ALLOWED_EMAILS"),

  /**
   * Haslo bramki (snapshot przy starcie). Runtime: getSiteGatePassword().
   * Lepiej SITE_GATE_PASSWORD_B64 gdy haslo zawiera #.
   */
  get siteGatePassword(): string {
    return getSiteGatePassword();
  },

  db: resolvedDb.db,
  /** Blad konfiguracji DB z chwili importu (np. sqlite:// w DATABASE_URL). */
  dbConfigError: resolvedDb.error as string | null,

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
