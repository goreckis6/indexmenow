"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.pool = void 0;
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
exports.db = new kysely_1.Kysely({
    dialect: new kysely_1.MysqlDialect({ pool: exports.pool }),
});
async function closeDatabase() {
    await exports.db.destroy();
}
//# sourceMappingURL=index.js.map