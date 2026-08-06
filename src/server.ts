import path from "node:path";
import express from "express";
import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";
import multer from "multer";
import { config, ROOT_DIR } from "./config";
import { closeDatabase, pool } from "./db";
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

async function main(): Promise<void> {
  await migrate();

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
    // Cast: @types/express-mysql-session wlecze wlasna kopie typow mysql2,
    // ktora nie zgadza sie z biezacym pakietem mimo identycznego API.
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
        // Za TLS-terminujacym proxy Hostingera ciasteczko musi byc Secure.
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

  // Multer tylko na trasach, ktore przyjmuja pliki - inaczej kazdy POST
  // bez multipart dostalby blad Content-Type.
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

  const server = app.listen(config.port, config.host, () => {
    console.log(`${config.appName} dziala na ${config.baseUrl} (bind ${config.host}:${config.port})`);
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
