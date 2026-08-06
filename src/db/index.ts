import { Kysely, MysqlDialect } from "kysely";
import mysql from "mysql2";
import { config } from "../config";
import type { Database } from "./types";

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: 10,
  waitForConnections: true,
  // Wszystkie znaczniki czasu trzymamy w UTC. Bez tego mysql2 interpretowalby
  // DATETIME w strefie serwera bazy, ktora rzadko jest ta sama co strefa aplikacji.
  timezone: "Z",
  // Kolumny DATE maja wracac jako "RRRR-MM-DD". Jako obiekt Date gubilyby
  // sens przy porownywaniu dni, bo doklejalaby sie do nich godzina i strefa.
  dateStrings: ["DATE"],
  typeCast(field, next) {
    // MySQL nie ma typu boolean - BOOLEAN to alias na TINYINT(1).
    if (field.type === "TINY" && field.length === 1) {
      const value = field.string();
      return value === null ? null : value === "1";
    }
    return next();
  },
});

export const db = new Kysely<Database>({
  dialect: new MysqlDialect({ pool }),
});

export async function closeDatabase(): Promise<void> {
  await db.destroy();
}
