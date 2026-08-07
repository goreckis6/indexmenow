"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../db");
const migrate_1 = require("../db/migrate");
async function main() {
    await (0, migrate_1.migrate)();
    console.log("Schemat bazy zaktualizowany.");
    await db_1.db.destroy();
}
void main().catch((error) => {
    console.error("Migracja nie powiodla sie:", error);
    process.exitCode = 1;
    void db_1.db.destroy();
});
//# sourceMappingURL=migrate.js.map