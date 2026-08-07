"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.generateIndexNowKey = generateIndexNowKey;
exports.generateState = generateState;
exports.sha256 = sha256;
const node_crypto_1 = __importDefault(require("node:crypto"));
const config_1 = require("../config");
/**
 * Odpowiednik Fernet z wersji Pythona. Fernet nie ma odpowiednika w bibliotece
 * standardowej Node, wiec uzywamy AES-256-GCM, ktory daje to samo: szyfrowanie
 * z uwierzytelnieniem, wiec podmieniony token zostanie odrzucony, a nie
 * odszyfrowany do sieczki.
 *
 * Format: v1.<iv>.<tag>.<ciphertext>, wszystko w base64url. Prefiks wersji
 * pozwoli kiedys zmienic algorytm bez zgadywania, czym zaszyfrowano stare wpisy.
 */
const VERSION = "v1";
const IV_BYTES = 12;
function encrypt(value) {
    if (value === null || value === undefined)
        return null;
    const iv = node_crypto_1.default.randomBytes(IV_BYTES);
    const cipher = node_crypto_1.default.createCipheriv("aes-256-gcm", config_1.config.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
        VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
    ].join(".");
}
function decrypt(value) {
    if (!value)
        return null;
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION)
        return null;
    const [, ivPart, tagPart, dataPart] = parts;
    try {
        const decipher = node_crypto_1.default.createDecipheriv("aes-256-gcm", config_1.config.encryptionKey, Buffer.from(ivPart, "base64url"));
        decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
        return Buffer.concat([
            decipher.update(Buffer.from(dataPart, "base64url")),
            decipher.final(),
        ]).toString("utf8");
    }
    catch {
        // Zly klucz albo naruszony szyfrogram. Zwracamy null, zeby wywolujacy
        // potraktowal to jak brak tokenu i poprosil o ponowne logowanie.
        return null;
    }
}
/** Klucze IndexNow musza miec 8-128 znakow szesnastkowych. */
function generateIndexNowKey() {
    return node_crypto_1.default.randomBytes(16).toString("hex");
}
function generateState() {
    return node_crypto_1.default.randomBytes(24).toString("base64url");
}
/** Uzywane do unikalnych indeksow na dlugich adresach - patrz db/migrate.ts. */
function sha256(value) {
    return node_crypto_1.default.createHash("sha256").update(value, "utf8").digest("hex");
}
//# sourceMappingURL=crypto.js.map