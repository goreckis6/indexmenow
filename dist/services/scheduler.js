"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRunning = isRunning;
exports.runningTasks = runningTasks;
exports.runInBackground = runInBackground;
exports.jobAutoIndex = jobAutoIndex;
exports.jobScanSitemaps = jobScanSitemaps;
exports.jobDailySnapshot = jobDailySnapshot;
exports.startScheduler = startScheduler;
exports.shutdownScheduler = shutdownScheduler;
exports.nextRunTimes = nextRunTimes;
exports.schedulerStatus = schedulerStatus;
const node_crypto_1 = __importDefault(require("node:crypto"));
const croner_1 = require("croner");
const kysely_1 = require("kysely");
const config_1 = require("../config");
const db_1 = require("../db");
const activity_1 = require("./activity");
const indexer_1 = require("./indexer");
const sitemaps_1 = require("./sitemaps");
const stats_1 = require("./stats");
const LOCK_NAME = "scheduler";
/** Po tym czasie bez odswiezenia blokada uznawana jest za porzucona. */
const LOCK_TTL_SECONDS = 300;
const HEARTBEAT_SECONDS = 60;
const INSTANCE_ID = `${process.pid}-${node_crypto_1.default.randomBytes(4).toString("hex")}`;
const runningTaskKeys = new Set();
let jobs = [];
let heartbeat = null;
let ownsLock = false;
function isRunning(taskKey) {
    return runningTaskKeys.has(taskKey);
}
function runningTasks() {
    return [...runningTaskKeys].sort();
}
/**
 * Uruchamia zadanie poza cyklem zadania HTTP. Zwraca false, gdy to samo
 * zadanie juz trwa - dzieki temu podwojne klikniecie w panelu nie zgłosi
 * tych samych URL-i dwa razy.
 */
function runInBackground(taskKey, fn) {
    if (runningTaskKeys.has(taskKey))
        return false;
    runningTaskKeys.add(taskKey);
    void (async () => {
        try {
            await fn();
        }
        catch (error) {
            console.error(`Zadanie w tle nie powiodlo sie: ${taskKey}`, error);
        }
        finally {
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
async function holdsLock() {
    const row = await db_1.db
        .selectFrom("scheduler_lock")
        .select("owner")
        .where("name", "=", LOCK_NAME)
        .executeTakeFirst();
    return row?.owner === INSTANCE_ID;
}
async function acquireLock() {
    const now = new Date();
    // Wiersz musi istniec, zeby ponizszy UPDATE mial co zmieniac. IGNORE zamiast
    // zwyklego INSERT, bo przy wyscigu dwoch instancji jedna dostalaby blad
    // duplikatu klucza.
    await (0, kysely_1.sql) `
    INSERT IGNORE INTO scheduler_lock (name, owner, acquired_at, heartbeat_at)
    VALUES (${LOCK_NAME}, ${INSTANCE_ID}, ${now}, ${now})
  `.execute(db_1.db);
    // Blokade przejmujemy tylko wtedy, gdy juz jest nasza albo poprzedni
    // wlasciciel przestal odswiezac wpis.
    const cutoff = new Date(Date.now() - LOCK_TTL_SECONDS * 1000);
    await db_1.db
        .updateTable("scheduler_lock")
        .set({ owner: INSTANCE_ID, acquired_at: now, heartbeat_at: now })
        .where("name", "=", LOCK_NAME)
        .where((eb) => eb.or([eb("owner", "=", INSTANCE_ID), eb("heartbeat_at", "<", cutoff)]))
        .execute();
    // Liczba zmodyfikowanych wierszy nie jest tu wiarygodna: przy dwoch probach
    // w tej samej sekundzie MySQL nie zglasza zmiany, bo wartosci sa identyczne.
    return holdsLock();
}
async function refreshLock() {
    if (ownsLock) {
        await db_1.db
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
    if (ownsLock)
        console.log("Scheduler: przejalem blokade zadan cyklicznych.");
}
async function guarded(name, fn) {
    if (!ownsLock)
        return;
    if (runningTaskKeys.has(name)) {
        console.log(`Zadanie ${name} juz trwa - pomijam.`);
        return;
    }
    runningTaskKeys.add(name);
    try {
        await fn();
    }
    catch (error) {
        console.error(`Zadanie ${name} nie powiodlo sie`, error);
    }
    finally {
        runningTaskKeys.delete(name);
    }
}
/** Codzienny przebieg po wszystkich stronach z wlaczonym auto-indeksowaniem. */
async function jobAutoIndex() {
    const workspaces = await db_1.db
        .selectFrom("workspaces")
        .selectAll()
        .where("auto_index_enabled", "=", true)
        .execute();
    for (const workspace of workspaces) {
        const user = await db_1.db
            .selectFrom("users")
            .innerJoin("google_credentials", "google_credentials.user_id", "users.id")
            .select(["users.id as id", "users.email as email", "users.is_active as is_active"])
            .where("users.id", "=", workspace.user_id)
            .executeTakeFirst();
        // Bez zapisanych tokenow Google nie ma czym sie uwierzytelnic.
        if (!user || !user.is_active)
            continue;
        const sites = await db_1.db
            .selectFrom("sites")
            .selectAll()
            .where("workspace_id", "=", workspace.id)
            .where("auto_index", "=", true)
            .where("is_active", "=", true)
            .execute();
        for (const site of sites) {
            try {
                await (0, indexer_1.runSitePipeline)(user.id, user.email, workspace, site, "auto");
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                console.error(`Auto-indeksowanie nie powiodlo sie dla ${site.display_name}`, error);
                await (0, activity_1.logEvent)(`Auto-indeksowanie ${site.display_name} nie powiodlo sie: ${reason}`, {
                    workspaceId: workspace.id,
                    level: "error",
                    category: "indexing",
                });
            }
        }
    }
}
async function jobScanSitemaps() {
    const sites = await db_1.db.selectFrom("sites").selectAll().where("is_active", "=", true).execute();
    for (const site of sites) {
        try {
            await (0, sitemaps_1.scanAllSitemaps)(site);
        }
        catch (error) {
            console.error(`Skan sitemap nie powiodl sie dla ${site.display_name}`, error);
        }
    }
}
async function jobDailySnapshot() {
    const sites = await db_1.db.selectFrom("sites").select("id").execute();
    for (const site of sites) {
        await (0, stats_1.recordSiteSnapshot)(site);
    }
}
async function startScheduler() {
    if (jobs.length > 0)
        return;
    if (!config_1.config.schedulerEnabled) {
        console.log("Scheduler wylaczony przez SCHEDULER_ENABLED=false.");
        return;
    }
    ownsLock = await acquireLock();
    heartbeat = setInterval(() => {
        void refreshLock();
    }, HEARTBEAT_SECONDS * 1000);
    const options = { timezone: config_1.config.timezone, protect: true };
    jobs = [
        new croner_1.Cron(`0 ${config_1.config.autoIndexHour} * * *`, options, () => guarded("auto-index-all", jobAutoIndex)),
        new croner_1.Cron(`0 */${Math.max(1, config_1.config.sitemapScanIntervalHours)} * * *`, options, () => guarded("scan-sitemaps-all", jobScanSitemaps)),
        new croner_1.Cron("50 23 * * *", options, () => guarded("daily-snapshot", jobDailySnapshot)),
    ];
    console.log(`Scheduler wystartowal (auto-index o ${String(config_1.config.autoIndexHour).padStart(2, "0")}:00, ` +
        `skan sitemap co ${config_1.config.sitemapScanIntervalHours}h, blokada: ${ownsLock ? "przejeta" : "u innej instancji"})`);
}
async function shutdownScheduler() {
    for (const job of jobs)
        job.stop();
    jobs = [];
    if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
    if (ownsLock) {
        // Zwolnienie blokady przy zamknieciu pozwala innej instancji przejac
        // zadania od razu, bez czekania na wygasniecie wpisu.
        await db_1.db
            .deleteFrom("scheduler_lock")
            .where("name", "=", LOCK_NAME)
            .where("owner", "=", INSTANCE_ID)
            .execute()
            .catch(() => undefined);
        ownsLock = false;
    }
}
function nextRunTimes() {
    const names = ["auto-index", "scan-sitemaps", "daily-snapshot"];
    return jobs.map((job, i) => ({
        id: names[i] ?? `job-${i}`,
        next_run: job.nextRun()?.toISOString() ?? null,
    }));
}
function schedulerStatus() {
    return {
        enabled: config_1.config.schedulerEnabled,
        ownsLock,
        instance: INSTANCE_ID,
        running: runningTasks(),
        next: nextRunTimes(),
    };
}
//# sourceMappingURL=scheduler.js.map