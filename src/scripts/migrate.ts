import { db } from "../db/index.js";
import { migrate } from "../db/migrate.js";

async function main(): Promise<void> {
  await migrate();
  console.log("Schemat bazy zaktualizowany.");
  await db.destroy();
}

void main().catch((error) => {
  console.error("Migracja nie powiodla sie:", error);
  process.exitCode = 1;
  void db.destroy();
});
