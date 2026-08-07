"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.pool = void 0;
exports.pingDatabase = pingDatabase;
exports.closeDatabase = closeDatabase;
const kysely_1 = require("kysely");
const mysql2_1 = __importDefault(require("mysql2"));
const config_1 = require("../config");
exports.pool = mysql2_1.default.createPool({
    host: config_1.config.db.host,
    port: config_1.config.db.port,
    user: config_1.config.db.user,
    password: config_1.config.db.password,
    database: config_1.config.db.database,
    connectionLimit: 10,
    waitForConnections: true,
    // Bez limitu Hostinger zabija proces (503), zanim zdazymy zalogowac blad.
    connectTimeout: 8_000,
    timezone: "Z",
    dateStrings: ["DATE"],
    typeCast(field, next) {
        if (field.type === "TINY" && field.length === 1) {
            const value = field.string();
            return value === null ? null : value === "1";
        }
        return next();
    },
});
exports.db = new kysely_1.Kysely({
    dialect: new kysely_1.MysqlDialect({ pool: exports.pool }),
});
/** Szybki test polaczenia - rzuca z czytelnym komunikatem zamiast wisiec. */
async function pingDatabase() {
    const connection = await exports.pool.promise().getConnection();
    try {
        await connection.query("SELECT 1");
    }
    finally {
        connection.release();
    }
}
async function closeDatabase() {
    await exports.db.destroy();
}
//# sourceMappingURL=index.js.map