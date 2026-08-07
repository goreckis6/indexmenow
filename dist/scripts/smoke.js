"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Test na prawdziwym MySQL. Sprawdza te fragmenty, ktorych typy nie wychwyca:
 * upserty, unikalne indeksy na hashach adresow, konwersje dat i wartosci
 * logicznych oraz blokade schedulera.
 *
 *   npm run smoke
 */
const strict_1 = __importDefault(require("node:assert/strict"));
const db_1 = require("../db");
const migrate_1 = require("../db/migrate");
const crypto_1 = require("../lib/crypto");
const types_1 = require("../db/types");
const quota = __importStar(require("../services/quota"));
const urls_1 = require("../services/urls");
const workspaces_1 = require("../services/workspaces");
const stats_1 = require("../services/stats");
const scheduler_1 = require("../services/scheduler");
const dates_1 = require("../lib/dates");
const checks = [];
function ok(name) {
    checks.push(name);
    console.log(`  ok  ${name}`);
}
async function reset() {
    await db_1.db.deleteFrom("users").execute();
    await db_1.db.deleteFrom("scheduler_lock").execute();
}
async function main() {
    await (0, migrate_1.migrate)();
    await reset();
    // --- szyfrowanie
    const secret = "ya29.przykladowy-token-dostepu";
    const encrypted = (0, crypto_1.encrypt)(secret);
    strict_1.default.notEqual(encrypted, secret);
    strict_1.default.equal((0, crypto_1.decrypt)(encrypted), secret);
    strict_1.default.equal((0, crypto_1.decrypt)("v1.zle.dane.tutaj"), null);
    ok("szyfrowanie tokenow (AES-256-GCM) szyfruje i odszyfrowuje");
    // --- uzytkownik i workspace
    const userInsert = await db_1.db
        .insertInto("users")
        .values({ google_sub: "sub-1", email: "test@example.com", name: "Test", is_admin: true })
        .executeTakeFirst();
    const userId = Number(userInsert.insertId);
    const user = await db_1.db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
    strict_1.default.equal(user.is_active, true);
    strict_1.default.equal(user.is_admin, true);
    strict_1.default.ok(user.created_at instanceof Date);
    ok("TINYINT(1) wraca jako boolean, DATETIME jako Date");
    const workspace = await (0, workspaces_1.createWorkspace)(user.id, "Moj panel");
    strict_1.default.equal(workspace.slug, "moj-panel");
    const second = await (0, workspaces_1.createWorkspace)(user.id, "Moj panel");
    strict_1.default.equal(second.slug, "moj-panel-2");
    ok("slugi workspace nie koliduja");
    // --- strona
    const siteInsert = await db_1.db
        .insertInto("sites")
        .values({
        workspace_id: workspace.id,
        property_url: "https://example.com/",
        display_name: "example.com",
        home_url: "https://example.com/",
        permission_level: "siteOwner",
    })
        .executeTakeFirst();
    const siteId = Number(siteInsert.insertId);
    const site = await db_1.db.selectFrom("sites").selectAll().where("id", "=", siteId).executeTakeFirstOrThrow();
    // --- normalizacja i deduplikacja adresow
    strict_1.default.equal((0, urls_1.normalizeUrl)("https://example.com"), "https://example.com/");
    strict_1.default.equal((0, urls_1.normalizeUrl)("https://example.com/a#sekcja"), "https://example.com/a");
    strict_1.default.equal((0, urls_1.normalizeUrl)("example.com/a"), "https://example.com/a", "brak schematu = https");
    strict_1.default.equal((0, urls_1.normalizeUrl)("https://example.com/a?utm_source=x&id=7"), "https://example.com/a?id=7", "parametry sledzace musza zniknac, reszta zostac");
    strict_1.default.equal((0, urls_1.normalizeUrl)("nie-adres"), null, "host bez kropki to literowka, nie adres");
    strict_1.default.equal((0, urls_1.normalizeUrl)(""), null);
    strict_1.default.equal((0, urls_1.normalizeUrl)("#sekcja"), null);
    ok("normalizacja adresow odrzuca smieci i czysci parametry sledzace");
    const first = await (0, urls_1.addUrls)(site, ["https://example.com/a", "https://example.com/b"], "sitemap");
    strict_1.default.equal(first.added, 2);
    const again = await (0, urls_1.addUrls)(site, ["https://example.com/a", "https://example.com/c"], "sitemap");
    strict_1.default.equal(again.added, 1, "istniejacy adres nie moze zostac dodany ponownie");
    const total = await db_1.db
        .selectFrom("urls")
        .select(({ fn }) => fn.countAll().as("count"))
        .where("site_id", "=", siteId)
        .executeTakeFirstOrThrow();
    strict_1.default.equal(Number(total.count), 3);
    ok("deduplikacja adresow po hashu dziala");
    // Bardzo dlugi adres - powod, dla ktorego indeks jest na hashu, a nie na kolumnie.
    const longUrl = `https://example.com/${"x".repeat(1200)}`;
    const longFirst = await (0, urls_1.addUrls)(site, [longUrl], "manual");
    const longAgain = await (0, urls_1.addUrls)(site, [longUrl], "manual");
    strict_1.default.equal(longFirst.added, 1);
    strict_1.default.equal(longAgain.added, 0, "adres dluzszy niz limit indeksu tez musi byc deduplikowany");
    ok("adres 1200+ znakow zapisuje sie i nie duplikuje");
    // --- limity dzienne (upsert)
    strict_1.default.equal(await quota.getUsage(workspace.id), 0);
    await quota.consume(workspace.id, 5);
    await quota.consume(workspace.id, 3);
    strict_1.default.equal(await quota.getUsage(workspace.id), 8, "drugie zuzycie musi sie dodac, nie nadpisac");
    strict_1.default.equal(await quota.remaining(workspace), workspace.daily_quota - 8);
    ok("licznik limitu sumuje sie przez ON DUPLICATE KEY UPDATE");
    // --- statystyki dzienne (upsert)
    await db_1.db
        .updateTable("urls")
        .set({ index_status: types_1.IndexStatus.INDEXED })
        .where("site_id", "=", siteId)
        .where("url", "=", "https://example.com/a")
        .execute();
    await (0, stats_1.recordSiteSnapshot)(site);
    await (0, stats_1.recordSiteSnapshot)(site);
    const snapshots = await db_1.db.selectFrom("site_stats").selectAll().where("site_id", "=", siteId).execute();
    strict_1.default.equal(snapshots.length, 1, "drugi zapis tego samego dnia musi nadpisac, nie dodac wiersza");
    strict_1.default.equal(snapshots[0]?.indexed, 1);
    strict_1.default.equal(snapshots[0]?.day, (0, dates_1.todayIso)(), "kolumna DATE musi wracac jako YYYY-MM-DD");
    ok("dzienna migawka statystyk nadpisuje sie w obrebie dnia");
    // --- historia zadan z polem JSON
    await db_1.db
        .insertInto("index_jobs")
        .values({
        site_id: siteId,
        job_type: types_1.JobType.URL_UPDATED,
        status: types_1.JobStatus.SUCCESS,
        target: "https://example.com/a",
        message: "ok",
        payload: JSON.stringify({ urlNotificationMetadata: { url: "https://example.com/a" } }),
        triggered_by: "test",
        duration_ms: 123,
    })
        .execute();
    const job = await db_1.db.selectFrom("index_jobs").selectAll().where("site_id", "=", siteId).executeTakeFirstOrThrow();
    strict_1.default.deepEqual(job.payload, { urlNotificationMetadata: { url: "https://example.com/a" } });
    strict_1.default.equal(job.engine, "google", "domyslny silnik musi byc ustawiony przez baze");
    ok("zadania zapisuja odpowiedz API w kolumnie JSON");
    // --- blokada schedulera
    strict_1.default.equal((0, scheduler_1.schedulerStatus)().ownsLock, false, "przed startem blokada nie moze byc przejeta");
    const now = new Date();
    await db_1.db
        .insertInto("scheduler_lock")
        .values({ name: "scheduler", owner: "inna-instancja", acquired_at: now, heartbeat_at: now })
        .execute();
    const held = await db_1.db.selectFrom("scheduler_lock").selectAll().executeTakeFirstOrThrow();
    strict_1.default.equal(held.owner, "inna-instancja");
    ok("wpis blokady schedulera zapisuje sie poprawnie");
    await db_1.db.deleteFrom("scheduler_lock").execute();
    await reset();
    console.log(`\n${checks.length} testow przeszlo.`);
    await db_1.db.destroy();
}
void main().catch(async (error) => {
    console.error("\nTest nie przeszedl:", error);
    process.exitCode = 1;
    await db_1.db.destroy();
});
//# sourceMappingURL=smoke.js.map