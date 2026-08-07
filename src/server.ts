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

function assertProductionConfig(): void {
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

  // Na Hostingerze PORT jest wstrzykiwany automatycznie - bez niego i tak
  // polecimy na 8006, ktorego proxy nie zna, i dostaniemy 503.
  if (config.isHttps && !process.env["PORT"]) {
    console.warn(
      "Uwaga: brak zmiennej PORT. Hostinger powinien ja ustawic sam. " +
        "Jesli jej nie ma, proxy nie trafi w proces.",
    );
  }

  if (config.isHttps && missing.length > 0) {
    throw new Error(
      `Brak wymaganych zmiennych srodowiskowych w hPanel: ${missing.join(", ")}. ` +
        "Websites → Twoja strona → Environment variables.",
    );
  }
}

async function main(): Promise<void> {
  console.log(
    `Start ${config.appName}: PORT=${config.port} BASE_URL=${config.baseUrl} ` +
      `DB=${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`,
  );
  console.log(
    `Env: PORT=${process.env["PORT"] ? "set" : "MISSING"} ` +
      `DB_HOST=${process.env["DB_HOST"] ? "set" : "MISSING"} ` +
      `DB_USER=${process.env["DB_USER"] ? "set" : "MISSING"} ` +
      `DB_NAME=${process.env["DB_NAME"] ? "set" : "MISSING"} ` +
      `DB_PASSWORD=${process.env["DB_PASSWORD"] ? "set" : "MISSING"} ` +
      `SECRET_KEY=${process.env["SECRET_KEY"] ? "set" : "MISSING"} ` +
      `BASE_URL=${process.env["BASE_URL"] ? "set" : "MISSING"}`,
  );

  assertProductionConfig();

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
    throw error;
  }

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

  // Hostinger w docsach Express pokazuje wylacznie listen(port) - bez hosta.
  // Podanie HOST=0.0.0.0 czasem psuje ich proxy i daje 503 mimo zywego procesu.
  const port = config.port;
  const server = app.listen(port, () => {
    console.log(`${config.appName} nasluchuje na porcie ${port} (BASE_URL=${config.baseUrl})`);
    if (!config.googleConfigured) {
      console.warn("Brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET - logowanie bedzie niedostepne.");
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`Otrzymano ${signal}, zamykam...`);
    await shutdownScheduler();
    server.close(async () => {
      await closeDatabase();
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
