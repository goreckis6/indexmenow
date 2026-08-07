import path from "node:path";
import express from "express";
import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";
import multer from "multer";
import { config, ROOT_DIR } from "./config";
import { closeDatabase, pingDatabase, pool } from "./db";
import { migrate } from "./db/migrate";
import { HttpError, loadUser } from "./middleware/auth";
import { apiRouter } from "./routes/api";
import { authRouter } from "./routes/auth";
import { dashboardRouter } from "./routes/dashboard";
import { historyRouter } from "./routes/history";
import { settingsRouter } from "./routes/settings";
import { sitesRouter } from "./routes/sites";
import { toolsRouter } from "./routes/tools";
import { urlsRouter } from "./routes/urls";
import { shutdownScheduler, startScheduler } from "./services/scheduler";
import { baseContext, configureTemplates } from "./templating";
import "./types";

const MySQLStore = MySQLStoreFactory(session as unknown as typeof import("express-session"));

function envPresenceLine(): string {
  return (
    `Env: PORT=${process.env["PORT"] ? "set" : "MISSING"} ` +
    `DB_HOST=${process.env["DB_HOST"] || process.env["MYSQL_HOST"] ? "set" : "MISSING"} ` +
    `DB_USER=${process.env["DB_USER"] || process.env["MYSQL_USER"] ? "set" : "MISSING"} ` +
    `DB_NAME=${process.env["DB_NAME"] || process.env["MYSQL_DATABASE"] ? "set" : "MISSING"} ` +
    `DB_PASSWORD=${process.env["DB_PASSWORD"] || process.env["MYSQL_PASSWORD"] ? "set" : "MISSING"} ` +
    `SECRET_KEY=${process.env["SECRET_KEY"] ? "set" : "MISSING"} ` +
    `BASE_URL=${process.env["BASE_URL"] ? "set" : "MISSING"}`
  );
}

function collectMissingEnv(): string[] {
  const missing: string[] = [];
  if (!process.env["DB_HOST"] && !process.env["DATABASE_URL"] && !process.env["MYSQL_HOST"]) {
    missing.push("DB_HOST (albo DATABASE_URL)");
  }
  if (!process.env["DB_USER"] && !process.env["DATABASE_URL"] && !process.env["MYSQL_USER"]) {
    missing.push("DB_USER");
  }
  if (!process.env["DB_NAME"] && !process.env["DATABASE_URL"] && !process.env["MYSQL_DATABASE"]) {
    missing.push("DB_NAME");
  }
  if (
    !process.env["DB_PASSWORD"] &&
    !process.env["DATABASE_URL"] &&
    !process.env["MYSQL_PASSWORD"]
  ) {
    missing.push("DB_PASSWORD");
  }
  if (!process.env["SECRET_KEY"]) missing.push("SECRET_KEY");
  if (!process.env["BASE_URL"]) missing.push("BASE_URL");
  return missing;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function diagnosticHtml(reason: string): string {
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
    .ok{color:#0a7}
    .bad{color:#b00}
  </style>
</head>
<body>
  <h1>IndexMeNow działa, ale nie jest gotowe</h1>
  <p>Proces Node nasłuchuje (to już nie jest martwy 503 CDN). Brakuje bazy / zmiennych:</p>
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
  <p>Dane MySQL bierz z <strong>Databases → MySQL</strong> (prefix <code>uXXXX_</code>). Potem Redeploy / Restart.</p>
  <p><a href="/healthz">/healthz</a></p>
</body>
</html>`;
}

function listenAndStayAlive(app: express.Express, label: string): void {
  const port = config.port;
  const server = app.listen(port, () => {
    console.log(`${label} na porcie ${port} (BASE_URL=${config.baseUrl})`);
  });

  const shutdown = async (signal: string) => {
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

function startDiagnosticServer(reason: string): void {
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

  listenAndStayAlive(app, `${config.appName} (tryb diagnostyczny)`);
}

async function startFullApp(): Promise<void> {
  const app = express();
  app.set("trust proxy", 1);

  const sessionStore = new MySQLStore(
    {
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
    },
    pool as never,
  );

  app.use(
    session({
      name: "imp_session",
      secret: config.secretKey,
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: "lax",
        secure: config.isHttps,
        httpOnly: true,
      },
    }),
  );

  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/static", express.static(path.join(ROOT_DIR, "public"), { maxAge: "1d" }));

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

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", app: config.appName, version: "1.0.0" });
  });

  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    const detail =
      err instanceof HttpError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Wewnetrzny blad serwera";

    if (status >= 500) console.error(err);

    if (req.path.startsWith("/api/") || status === 401) {
      res.status(status).json({ detail });
      return;
    }

    if (status === 404) {
      res.status(404).render("errors/404.html", baseContext(req));
      return;
    }

    res.status(status).render(
      "errors/generic.html",
      baseContext(req, { status_code: status, detail }),
    );
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

  listenAndStayAlive(app, config.appName);
}

async function main(): Promise<void> {
  console.log(
    `Start ${config.appName}: PORT=${config.port} BASE_URL=${config.baseUrl} ` +
      `DB=${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`,
  );
  console.log(envPresenceLine());

  if (config.isHttps && !process.env["PORT"]) {
    console.warn(
      "Uwaga: brak zmiennej PORT. Hostinger powinien ja ustawic sam. " +
        "Jesli jej nie ma, proxy nie trafi w proces i zobaczysz 503 CDN.",
    );
  }

  const missing = collectMissingEnv();
  if (config.isHttps && missing.length > 0) {
    const reason =
      `Brak wymaganych zmiennych w hPanel: ${missing.join(", ")}. ` +
      "Websites → Twoja strona → Environment variables.";
    console.error(reason);
    // Nie exit(1): zostajemy przy zyciu, zeby zamiast 503 CDN pokazac checklistę.
    startDiagnosticServer(reason);
    return;
  }

  try {
    await pingDatabase();
    console.log("Polaczenie z MySQL OK.");
    await migrate();
    console.log("Migracja schematu MySQL OK.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("Nie moge polaczyc sie z MySQL / utworzyc tabel:", reason);
    console.error(
      "W hPanel → Environment variables ustaw DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME " +
        "dokladnie jak w Databases → MySQL (z prefixem uXXXX_). Potem Redeploy.",
    );
    if (config.isHttps) {
      startDiagnosticServer(reason);
      return;
    }
    throw error;
  }

  await startFullApp();
}

main().catch((error) => {
  console.error("Nie udalo sie uruchomic aplikacji:", error);
  // Na produkcji HTTPS nadal sprobuj trzymac diagnostykę zamiast cichego 503.
  if (config.isHttps) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      startDiagnosticServer(reason);
      return;
    } catch (listenError) {
      console.error("Nie moge nawet otworzyc portu:", listenError);
    }
  }
  process.exit(1);
});
