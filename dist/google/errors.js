"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleApiError = void 0;
exports.parseError = parseError;
exports.safeJson = safeJson;
/** Blad z dowolnego endpointu Google, sprowadzony do jednego kształtu. */
class GoogleApiError extends Error {
    statusCode;
    payload;
    constructor(message, statusCode, payload) {
        super(message);
        this.name = "GoogleApiError";
        this.statusCode = statusCode;
        this.payload = payload ?? {};
    }
    get isQuota() {
        return this.statusCode === 429 || this.message.toLowerCase().includes("quota");
    }
    get isPermission() {
        return this.statusCode === 401 || this.statusCode === 403;
    }
    toString() {
        return this.statusCode ? `[${this.statusCode}] ${this.message}` : this.message;
    }
}
exports.GoogleApiError = GoogleApiError;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseError(statusCode, body) {
    if (isRecord(body)) {
        const err = body["error"];
        if (isRecord(err)) {
            const message = typeof err["message"] === "string" ? err["message"] : JSON.stringify(err);
            return new GoogleApiError(message, statusCode, body);
        }
        if (typeof err === "string") {
            const description = body["error_description"];
            const message = typeof description === "string" ? `${err}: ${description}` : err;
            return new GoogleApiError(message, statusCode, body);
        }
        return new GoogleApiError(JSON.stringify(body).slice(0, 500), statusCode, body);
    }
    return new GoogleApiError(String(body).slice(0, 500), statusCode);
}
/**
 * Google zwraca JSON przy bledach API, ale przy awarii proxy albo bramki
 * potrafi przyslac HTML. Zwracamy wtedy surowy tekst, zeby komunikat
 * w panelu nie byl pusty.
 */
async function safeJson(response) {
    const text = await response.text();
    if (!text)
        return "";
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
//# sourceMappingURL=errors.js.map