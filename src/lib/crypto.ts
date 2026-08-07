import crypto from "node:crypto";
import { config } from "../config.js";

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

export function encrypt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      config.encryptionKey,
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Zly klucz albo naruszony szyfrogram. Zwracamy null, zeby wywolujacy
    // potraktowal to jak brak tokenu i poprosil o ponowne logowanie.
    return null;
  }
}

/** Klucze IndexNow musza miec 8-128 znakow szesnastkowych. */
export function generateIndexNowKey(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function generateState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Uzywane do unikalnych indeksow na dlugich adresach - patrz db/migrate.ts. */
export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
