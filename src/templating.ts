import path from "node:path";
import type { Express, Request } from "express";
import nunjucks from "nunjucks";
import { ROOT_DIR, config } from "./config";
import { popFlashes } from "./middleware/auth";

const STATUS_LABELS: Record<string, string> = {
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

const STATUS_TONES: Record<string, string> = {
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

const JOB_TYPE_LABELS: Record<string, string> = {
  URL_UPDATED: "Zgloszenie URL",
  URL_DELETED: "Usuniecie URL",
  INSPECT: "Inspekcja",
  SITEMAP_SUBMIT: "Zgloszenie sitemapy",
  SITEMAP_DELETE: "Usuniecie sitemapy",
  INDEXNOW: "IndexNow",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function fmtDatetime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtRelative(value: Date | string | null | undefined): string {
  if (!value) return "nigdy";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "nigdy";

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return "za chwile";
  if (seconds < 60) return "przed chwila";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min temu`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} godz. temu`;

  const days = Math.floor(seconds / 86400);
  if (days === 1) return "wczoraj";
  if (days < 30) return `${days} dni temu`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} mies. temu` : `${Math.floor(days / 365)} lat temu`;
}

export function fmtNumber(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value ?? "—");
  // Spacja jako separator tysiecy, jak w polskiej konwencji.
  return Math.trunc(parsed).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function truncateUrl(value: string | null | undefined, length = 60): string {
  if (!value) return "—";
  const cleaned = value.replace(/^https?:\/\//, "");
  return cleaned.length <= length ? cleaned : `${cleaned.slice(0, length - 1)}…`;
}

export function configureTemplates(app: Express): nunjucks.Environment {
  const env = nunjucks.configure(path.join(ROOT_DIR, "views"), {
    autoescape: true,
    express: app,
    noCache: config.debug,
  });

  env.addFilter("dt", fmtDatetime);
  env.addFilter("ago", fmtRelative);
  env.addFilter("num", fmtNumber);
  env.addFilter("short_url", truncateUrl);
  env.addFilter("status_label", (value: unknown) => STATUS_LABELS[String(value)] ?? String(value ?? "—"));
  env.addFilter("status_tone", (value: unknown) => STATUS_TONES[String(value)] ?? "muted");
  env.addFilter("job_type", (value: unknown) => JOB_TYPE_LABELS[String(value)] ?? String(value ?? "—"));

  // Jinja2 ma |map(attribute="x")|list, Nunjucks nie - wykresy w szablonach
  // wyciagaja tym jedna kolumne z listy obiektow.
  env.addFilter("attr_list", (rows: unknown, attribute: string) => {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => (row as Record<string, unknown>)?.[attribute] ?? null);
  });

  // Odpowiednik |tojson z Jinja2. Nunjucks ma |dump, ale nie escapuje znakow,
  // ktore zamknelyby atrybut HTML, w ktorym te dane siedza.
  env.addFilter("tojson", (value: unknown) => {
    const json = JSON.stringify(value ?? null);
    return new nunjucks.runtime.SafeString(
      json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/'/g, "\\u0027"),
    );
  });

  // Jinja2 ma |min/|max na listach oraz '%02d'|format(...) - w Nunjucks nie ma
  // zadnego z nich, a szablony z nich korzystaja.
  env.addFilter("min", (rows: unknown) => (Array.isArray(rows) ? Math.min(...rows.map(Number)) : rows));
  env.addFilter("max", (rows: unknown) => (Array.isArray(rows) ? Math.max(...rows.map(Number)) : rows));
  env.addFilter("pad2", (value: unknown) => pad(Number(value) || 0));
  // Jinja2 ma |round i |int; Nunjucks nie - bez nich szablony z pokryciem i ms padaja.
  env.addFilter("round", (value: unknown, precision = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return value;
    const factor = 10 ** Number(precision);
    return Math.round(n * factor) / factor;
  });
  env.addFilter("int", (value: unknown) => {
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : 0;
  });
  env.addFilter("upper", (value: unknown) => String(value ?? "").toUpperCase());

  env.addGlobal("app_name", config.appName);
  env.addGlobal("now", () => new Date());

  return env;
}

/** Adres bazy do wyswietlenia w panelu - bez hasla. */
function maskedDatabaseUrl(): string {
  const { user, host, port, database } = config.db;
  return `mysql://${user}@${host}:${port}/${database}`;
}

export interface RenderContext {
  [key: string]: unknown;
}

/** Wspolny kontekst dla kazdej strony - odpowiednik render() z wersji Pythona. */
export function baseContext(req: Request, context: RenderContext = {}): RenderContext {
  return {
    flashes: popFlashes(req),
    app_settings: {
      app_name: config.appName,
      base_url: config.baseUrl,
      host: config.host,
      port: config.port,
      database_url: maskedDatabaseUrl(),
      google_configured: config.googleConfigured,
      timezone: config.timezone,
      default_daily_quota: config.defaultDailyQuota,
      auto_index_hour: config.autoIndexHour,
      sitemap_scan_interval_hours: config.sitemapScanIntervalHours,
      recheck_after_days: config.recheckAfterDays,
      inspection_batch_size: config.inspectionBatchSize,
    },
    user: req.user ?? null,
    workspace: req.workspace ?? null,
    request: { path: req.path, query: req.query, url: req.originalUrl },
    ...context,
  };
}
