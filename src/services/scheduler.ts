import crypto from "node:crypto";
import { Cron } from "croner";
import { sql } from "kysely";
import { config } from "../config";
import { db } from "../db";
import { logEvent } from "./activity";
import { runSitePipeline } from "./indexer";
import { scanAllSitemaps } from "./sitemaps";
import { recordSiteSnapshot } from "./stats";

const LOCK_NAME = "scheduler";
/** Po tym czasie bez odswiezenia blokada uznawana jest za porzucona. */
const LOCK_TTL_SECONDS = 300;
const HEARTBEAT_SECONDS = 60;

const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

const runningTaskKeys = new Set<string>();
let jobs: Cron[] = [];
let heartbeat: NodeJS.Timeout | null = null;
let ownsLock = false;

export function isRunning(taskKey: string): boolean {
  return runningTaskKeys.has(taskKey);
}

export function runningTasks(): string[] {
  return [...runningTaskKeys].sort();
}

/**
 * Uruchamia zadanie poza cyklem zadania HTTP. Zwraca false, gdy to samo
 * zadanie juz trwa - dzieki temu podwojne klikniecie w panelu nie zgłosi
 * tych samych URL-i dwa razy.
 */
export function runInBackground(taskKey: string, fn: () => Promise<unknown>): boolean {
  if (runningTaskKeys.has(taskKey)) return false;
  runningTaskKeys.add(taskKey);

  void (async () => {
    try {
      await fn();
    } catch (error) {
      console.error(`Zadanie w tle nie powiodlo sie: ${taskKey}`, error);
    } finally {
      runningTaskKeys.delete(taskKey);
    }
  })();

  return true;
}

/**
 * Zarzadzany hosting moze trzymac kilka instancji aplikacji naraz i kazda
 * probowalaby wykonac te same zadania. Blokada w bazie sprawia, ze cykliczne
 * zadania wykonuje dokladnie jedna instancja, a jesli ta padnie, inna przejmie
 * je po wygasnieciu wpisu.
 */
async function holdsLock(): Promise<boolean> {
  const row = await db
    .selectFrom("scheduler_lock")
    .select("owner")
    .where("name", "=", LOCK_NAME)
    .executeTakeFirst();
  return row?.owner === INSTANCE_ID;
}

async function acquireLock(): Promise<boolean> {
  const now = new Date();

  // Wiersz musi istniec, zeby ponizszy UPDATE mial co zmieniac. IGNORE zamiast
  // zwyklego INSERT, bo przy wyscigu dwoch instancji jedna dostalaby blad
  // duplikatu klucza.
  await sql`
    INSERT IGNORE INTO scheduler_lock (name, owner, acquired_at, heartbeat_at)
    VALUES (${LOCK_NAME}, ${INSTANCE_ID}, ${now}, ${now})
  `.execute(db);

  // Blokade przejmujemy tylko wtedy, gdy juz jest nasza albo poprzedni
  // wlasciciel przestal odswiezac wpis.
  const cutoff = new Date(Date.now() - LOCK_TTL_SECONDS * 1000);
  await db
    .updateTable("scheduler_lock")
    .set({ owner: INSTANCE_ID, acquired_at: now, heartbeat_at: now })
    .where("name", "=", LOCK_NAME)
    .where((eb) =>
      eb.or([eb("owner", "=", INSTANCE_ID), eb("heartbeat_at", "<", cutoff)]),
    )
    .execute();

  // Liczba zmodyfikowanych wierszy nie jest tu wiarygodna: przy dwoch probach
  // w tej samej sekundzie MySQL nie zglasza zmiany, bo wartosci sa identyczne.
  return holdsLock();
}

async function refreshLock(): Promise<void> {
  if (ownsLock) {
    await db
      .updateTable("scheduler_lock")
      .set({ heartbeat_at: new Date() })
      .where("name", "=", LOCK_NAME)
      .where("owner", "=", INSTANCE_ID)
      .execute();
    ownsLock = await holdsLock();
    if (!ownsLock) {
      console.log("Scheduler: blokada przejeta przez inna instancje - wstrzymuje zadania.");
    }
    return;
  }

  // Nie mamy blokady - sprawdzamy, czy poprzedni wlasciciel jej nie porzucil.
  ownsLock = await acquireLock();
  if (ownsLock) console.log("Scheduler: przejalem blokade zadan cyklicznych.");
}

async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  if (!ownsLock) return;
  if (runningTaskKeys.has(name)) {
    console.log(`Zadanie ${name} juz trwa - pomijam.`);
    return;
  }
  runningTaskKeys.add(name);
  try {
    await fn();
  } catch (error) {
    console.error(`Zadanie ${name} nie powiodlo sie`, error);
  } finally {
    runningTaskKeys.delete(name);
  }
}

/** Codzienny przebieg po wszystkich stronach z wlaczonym auto-indeksowaniem. */
export async function jobAutoIndex(): Promise<void> {
  const workspaces = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("auto_index_enabled", "=", true)
    .execute();

  for (const workspace of workspaces) {
    const user = await db
      .selectFrom("users")
      .innerJoin("google_credentials", "google_credentials.user_id", "users.id")
      .select(["users.id as id", "users.email as email", "users.is_active as is_active"])
      .where("users.id", "=", workspace.user_id)
      .executeTakeFirst();
    // Bez zapisanych tokenow Google nie ma czym sie uwierzytelnic.
    if (!user || !user.is_active) continue;

    const sites = await db
      .selectFrom("sites")
      .selectAll()
      .where("workspace_id", "=", workspace.id)
      .where("auto_index", "=", true)
      .where("is_active", "=", true)
      .execute();

    for (const site of sites) {
      try {
        await runSitePipeline(user.id, user.email, workspace, site, "auto");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`Auto-indeksowanie nie powiodlo sie dla ${site.display_name}`, error);
        await logEvent(`Auto-indeksowanie ${site.display_name} nie powiodlo sie: ${reason}`, {
          workspaceId: workspace.id,
          level: "error",
          category: "indexing",
        });
      }
    }
  }
}

export async function jobScanSitemaps(): Promise<void> {
  const sites = await db.selectFrom("sites").selectAll().where("is_active", "=", true).execute();
  for (const site of sites) {
    try {
      await scanAllSitemaps(site);
    } catch (error) {
      console.error(`Skan sitemap nie powiodl sie dla ${site.display_name}`, error);
    }
  }
}

export async function jobDailySnapshot(): Promise<void> {
  const sites = await db.selectFrom("sites").select("id").execute();
  for (const site of sites) {
    await recordSiteSnapshot(site);
  }
}

export async function startScheduler(): Promise<void> {
  if (jobs.length > 0) return;
  if (!config.schedulerEnabled) {
    console.log("Scheduler wylaczony przez SCHEDULER_ENABLED=false.");
    return;
  }

  ownsLock = await acquireLock();
  heartbeat = setInterval(() => {
    void refreshLock();
  }, HEARTBEAT_SECONDS * 1000);

  const options = { timezone: config.timezone, protect: true } as const;

  jobs = [
    new Cron(`0 ${config.autoIndexHour} * * *`, options, () =>
      guarded("auto-index-all", jobAutoIndex),
    ),
    new Cron(`0 */${Math.max(1, config.sitemapScanIntervalHours)} * * *`, options, () =>
      guarded("scan-sitemaps-all", jobScanSitemaps),
    ),
    new Cron("50 23 * * *", options, () => guarded("daily-snapshot", jobDailySnapshot)),
  ];

  console.log(
    `Scheduler wystartowal (auto-index o ${String(config.autoIndexHour).padStart(2, "0")}:00, ` +
      `skan sitemap co ${config.sitemapScanIntervalHours}h, blokada: ${ownsLock ? "przejeta" : "u innej instancji"})`,
  );
}

export async function shutdownScheduler(): Promise<void> {
  for (const job of jobs) job.stop();
  jobs = [];
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (ownsLock) {
    // Zwolnienie blokady przy zamknieciu pozwala innej instancji przejac
    // zadania od razu, bez czekania na wygasniecie wpisu.
    await db
      .deleteFrom("scheduler_lock")
      .where("name", "=", LOCK_NAME)
      .where("owner", "=", INSTANCE_ID)
      .execute()
      .catch(() => undefined);
    ownsLock = false;
  }
}

export interface NextRun {
  id: string;
  next_run: string | null;
}

export function nextRunTimes(): NextRun[] {
  const names = ["auto-index", "scan-sitemaps", "daily-snapshot"];
  return jobs.map((job, i) => ({
    id: names[i] ?? `job-${i}`,
    next_run: job.nextRun()?.toISOString() ?? null,
  }));
}

export function schedulerStatus() {
  return {
    enabled: config.schedulerEnabled,
    ownsLock,
    instance: INSTANCE_ID,
    running: runningTasks(),
    next: nextRunTimes(),
  };
}
