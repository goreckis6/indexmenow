import { Kysely, MysqlDialect } from "kysely";
import mysql from "mysql2";
import { config } from "../config.js";
import type { Database } from "./types.js";

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: 10,
  waitForConnections: true,
  // Bez limitu Hostinger zabija proces (503), zanim zdazymy zalogowac blad.
  connectTimeout: 8_000,
  timezone: "Z",
  dateStrings: ["DATE"],
  typeCast(field, next) {
    // MySQL 8+ czesto zwraca length != 1 dla TINYINT(1) — bez tego
    // boolean bywa liczba/Buffer i UI/toggle zachowuje sie dziwnie.
    if (field.type === "TINY") {
      const value = field.string();
      return value === null ? null : value === "1";
    }
    return next();
  },
});

export const db = new Kysely<Database>({
  dialect: new MysqlDialect({ pool }),
});

/** Szybki test polaczenia - rzuca z czytelnym komunikatem zamiast wisiec. */
export async function pingDatabase(): Promise<void> {
  const connection = await pool.promise().getConnection();
  try {
    await connection.query("SELECT 1");
  } finally {
    connection.release();
  }
}

export async function closeDatabase(): Promise<void> {
  await db.destroy();
}
