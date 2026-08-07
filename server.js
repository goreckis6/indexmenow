/**
 * Entry Hostingera — czysty Node ESM, BEZ tsx/esbuild.
 * (Na Hostingerze binarka esbuild ma EACCES, wiec tsx pada w runtime.)
 *
 * Najpierw listen(PORT), potem dynamiczny import dist/server.js.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT || "3000", 10);
const startedAt = new Date().toISOString();

console.log(
  `[boot] pid=${process.pid} PORT=${process.env.PORT || "MISSING"} listen=${port} at=${startedAt}`,
);

/** @type {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void} */
let handler = (req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/healthz")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        status: "booting",
        app: "IndexMeNow",
        port,
        envPort: process.env.PORT || null,
        pid: process.pid,
        startedAt,
      }),
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="pl"><head><meta charset="utf-8"/><title>IndexMeNow boot</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">
  <h1>IndexMeNow — boot OK</h1>
  <p>Proces Node nasluchuje na porcie <code>${port}</code>. Ladowanie aplikacji…</p>
  <p><a href="/healthz">/healthz</a></p>
</body></html>`);
};

function showBootError(err) {
  const message = err && err.stack ? err.stack : String(err);
  console.error("[boot] blad ladowania aplikacji:", message);
  handler = (req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/healthz")) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "boot_error",
          app: "IndexMeNow",
          port,
          envPort: process.env.PORT || null,
          error: String(err && err.message ? err.message : err),
        }),
      );
      return;
    }
    const safe = message
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html lang="pl"><head><meta charset="utf-8"/><title>IndexMeNow blad</title></head>
<body style="font-family:system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem">
  <h1>IndexMeNow — blad startu</h1>
  <p>Bootloader zyje (port ${port}), aplikacja nie wstala:</p>
  <pre style="background:#111;color:#eee;padding:1rem;border-radius:8px;white-space:pre-wrap">${safe}</pre>
</body></html>`);
  };
}

const server = http.createServer((req, res) => {
  try {
    handler(req, res);
  } catch (error) {
    console.error("[boot] handler crash:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("Internal boot handler error");
  }
});

server.listen(port, () => {
  console.log(`[boot] listening on ${port}`);

  const entry = path.join(__dirname, "dist", "server.js");
  import(pathToFileURL(entry).href)
    .then((mod) => {
      if (typeof mod.startFromBootloader !== "function") {
        throw new Error("dist/server.js nie eksportuje startFromBootloader");
      }
      return mod.startFromBootloader();
    })
    .then((app) => {
      if (!app || typeof app !== "function") {
        throw new Error("startFromBootloader nie zwrocil aplikacji Express");
      }
      handler = app;
      console.log("[boot] pelna aplikacja podpieta (ESM dist/server.js)");
    })
    .catch(showBootError);
});

server.on("error", (error) => {
  console.error("[boot] nie moge otworzyc portu", port, error);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[boot] uncaughtException:", error);
  showBootError(error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[boot] unhandledRejection:", reason);
  showBootError(reason instanceof Error ? reason : new Error(String(reason)));
});
