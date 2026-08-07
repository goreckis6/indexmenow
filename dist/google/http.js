"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleRequest = googleRequest;
exports.encodeProperty = encodeProperty;
const errors_1 = require("./errors");
const TIMEOUT_MS = 45_000;
/**
 * Jedno miejsce, przez ktore ida wszystkie zapytania do API Google.
 * Kazdy blad - sieciowy czy zwrocony przez Google - wychodzi stad jako
 * GoogleApiError, zeby warstwa wyzej nie musiala rozpoznawac typow wyjatkow.
 */
async function googleRequest(url, { method = "GET", accessToken, jsonBody, params }) {
    const target = params ? `${url}?${new URLSearchParams(params).toString()}` : url;
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
    };
    if (jsonBody !== undefined)
        headers["Content-Type"] = "application/json";
    let response;
    try {
        response = await fetch(target, {
            method,
            headers,
            ...(jsonBody === undefined ? {} : { body: JSON.stringify(jsonBody) }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new errors_1.GoogleApiError(`Blad polaczenia z Google: ${reason}`);
    }
    if (response.status === 204)
        return {};
    const data = await (0, errors_1.safeJson)(response);
    if (!response.ok)
        throw (0, errors_1.parseError)(response.status, data);
    return (data === "" ? {} : data);
}
function encodeProperty(propertyUrl) {
    return encodeURIComponent(propertyUrl);
}
//# sourceMappingURL=http.js.map