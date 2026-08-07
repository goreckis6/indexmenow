/**
 * Test na prawdziwym MySQL. Sprawdza te fragmenty, ktorych typy nie wychwyca:
 * upserty, unikalne indeksy na hashach adresow, konwersje dat i wartosci
 * logicznych oraz blokade schedulera.
 *
 *   npm run smoke
 */
import assert from "node:assert/strict";
import { db } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { IndexStatus, JobStatus, JobType } from "../db/types.js";
import * as quota from "../services/quota.js";
import { addUrls, normalizeUrl } from "../services/urls.js";
import { createWorkspace } from "../services/workspaces.js";
import { recordSiteSnapshot } from "../services/stats.js";
import { schedulerStatus } from "../services/scheduler.js";
import { todayIso } from "../lib/dates.js";

const checks: string[] = [];
function ok(name: string): void {
  checks.push(name);
  console.log(`  ok  ${name}`);
}

async function reset(): Promise<void> {
  await db.deleteFrom("users").execute();
  await db.deleteFrom("scheduler_lock").execute();
}

async function main(): Promise<void> {
  await migrate();
  await reset();

  // --- szyfrowanie
  const secret = "ya29.przykladowy-token-dostepu";
  const encrypted = encrypt(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(decrypt(encrypted), secret);
  assert.equal(decrypt("v1.zle.dane.tutaj"), null);
  ok("szyfrowanie tokenow (AES-256-GCM) szyfruje i odszyfrowuje");

  // --- uzytkownik i workspace
  const userInsert = await db
    .insertInto("users")
    .values({ google_sub: "sub-1", email: "test@example.com", name: "Test", is_admin: true })
    .executeTakeFirst();
  const userId = Number(userInsert.insertId);
  const user = await db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
  assert.equal(user.is_active, true);
  assert.equal(user.is_admin, true);
  assert.ok(user.created_at instanceof Date);
  ok("TINYINT(1) wraca jako boolean, DATETIME jako Date");

  const workspace = await createWorkspace(user.id, "Moj panel");
  assert.equal(workspace.slug, "moj-panel");
  const second = await createWorkspace(user.id, "Moj panel");
  assert.equal(second.slug, "moj-panel-2");
  ok("slugi workspace nie koliduja");

  // --- strona
  const siteInsert = await db
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
  const site = await db.selectFrom("sites").selectAll().where("id", "=", siteId).executeTakeFirstOrThrow();

  // --- normalizacja i deduplikacja adresow
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeUrl("https://example.com/a#sekcja"), "https://example.com/a");
  assert.equal(normalizeUrl("example.com/a"), "https://example.com/a", "brak schematu = https");
  assert.equal(
    normalizeUrl("https://example.com/a?utm_source=x&id=7"),
    "https://example.com/a?id=7",
    "parametry sledzace musza zniknac, reszta zostac",
  );
  assert.equal(normalizeUrl("nie-adres"), null, "host bez kropki to literowka, nie adres");
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("#sekcja"), null);
  ok("normalizacja adresow odrzuca smieci i czysci parametry sledzace");

  const first = await addUrls(site, ["https://example.com/a", "https://example.com/b"], "sitemap");
  assert.equal(first.added, 2);
  const again = await addUrls(site, ["https://example.com/a", "https://example.com/c"], "sitemap");
  assert.equal(again.added, 1, "istniejacy adres nie moze zostac dodany ponownie");
  const total = await db
    .selectFrom("urls")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("site_id", "=", siteId)
    .executeTakeFirstOrThrow();
  assert.equal(Number(total.count), 3);
  ok("deduplikacja adresow po hashu dziala");

  // Bardzo dlugi adres - powod, dla ktorego indeks jest na hashu, a nie na kolumnie.
  const longUrl = `https://example.com/${"x".repeat(1200)}`;
  const longFirst = await addUrls(site, [longUrl], "manual");
  const longAgain = await addUrls(site, [longUrl], "manual");
  assert.equal(longFirst.added, 1);
  assert.equal(longAgain.added, 0, "adres dluzszy niz limit indeksu tez musi byc deduplikowany");
  ok("adres 1200+ znakow zapisuje sie i nie duplikuje");

  // --- limity dzienne (upsert)
  assert.equal(await quota.getUsage(workspace.id), 0);
  await quota.consume(workspace.id, 5);
  await quota.consume(workspace.id, 3);
  assert.equal(await quota.getUsage(workspace.id), 8, "drugie zuzycie musi sie dodac, nie nadpisac");
  assert.equal(await quota.remaining(workspace), workspace.daily_quota - 8);
  ok("licznik limitu sumuje sie przez ON DUPLICATE KEY UPDATE");

  // --- statystyki dzienne (upsert)
  await db
    .updateTable("urls")
    .set({ index_status: IndexStatus.INDEXED })
    .where("site_id", "=", siteId)
    .where("url", "=", "https://example.com/a")
    .execute();
  await recordSiteSnapshot(site);
  await recordSiteSnapshot(site);
  const snapshots = await db.selectFrom("site_stats").selectAll().where("site_id", "=", siteId).execute();
  assert.equal(snapshots.length, 1, "drugi zapis tego samego dnia musi nadpisac, nie dodac wiersza");
  assert.equal(snapshots[0]?.indexed, 1);
  assert.equal(snapshots[0]?.day, todayIso(), "kolumna DATE musi wracac jako YYYY-MM-DD");
  ok("dzienna migawka statystyk nadpisuje sie w obrebie dnia");

  // --- historia zadan z polem JSON
  await db
    .insertInto("index_jobs")
    .values({
      site_id: siteId,
      job_type: JobType.URL_UPDATED,
      status: JobStatus.SUCCESS,
      target: "https://example.com/a",
      message: "ok",
      payload: JSON.stringify({ urlNotificationMetadata: { url: "https://example.com/a" } }),
      triggered_by: "test",
      duration_ms: 123,
    })
    .execute();
  const job = await db.selectFrom("index_jobs").selectAll().where("site_id", "=", siteId).executeTakeFirstOrThrow();
  assert.deepEqual(job.payload, { urlNotificationMetadata: { url: "https://example.com/a" } });
  assert.equal(job.engine, "google", "domyslny silnik musi byc ustawiony przez baze");
  ok("zadania zapisuja odpowiedz API w kolumnie JSON");

  // --- blokada schedulera
  assert.equal(schedulerStatus().ownsLock, false, "przed startem blokada nie moze byc przejeta");

  const now = new Date();
  await db
    .insertInto("scheduler_lock")
    .values({ name: "scheduler", owner: "inna-instancja", acquired_at: now, heartbeat_at: now })
    .execute();
  const held = await db.selectFrom("scheduler_lock").selectAll().executeTakeFirstOrThrow();
  assert.equal(held.owner, "inna-instancja");
  ok("wpis blokady schedulera zapisuje sie poprawnie");

  await db.deleteFrom("scheduler_lock").execute();
  await reset();
  console.log(`\n${checks.length} testow przeszlo.`);
  await db.destroy();
}

void main().catch(async (error) => {
  console.error("\nTest nie przeszedl:", error);
  process.exitCode = 1;
  await db.destroy();
});
