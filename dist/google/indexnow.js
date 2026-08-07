"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitUrls = submitUrls;
exports.keyFileUrl = keyFileUrl;
const errors_1 = require("./errors");
/** IndexNow jest wspolny dla Bing, Yandex, Seznam i Naver. */
const ENDPOINTS = {
    bing: "https://www.bing.com/indexnow",
    yandex: "https://yandex.com/indexnow",
    seznam: "https://search.seznam.cz/indexnow",
    generic: "https://api.indexnow.org/indexnow",
};
const STATUS_MEANING = {
    200: "Przyjeto zgloszenie",
    202: "Przyjeto - klucz oczekuje na weryfikacje",
    400: "Nieprawidlowy format zadania",
    403: "Klucz nieprawidlowy lub niedostepny pod podanym adresem",
    422: "URL-e nie naleza do tej domeny albo klucz sie nie zgadza",
    429: "Zbyt wiele zgloszen (rate limit)",
};
async function submitUrls(urls, key, keyLocation, engine = "generic") {
    if (urls.length === 0) {
        return { ok: false, status: 0, message: "Brak URL-i do zgloszenia", count: 0 };
    }
    const first = urls[0];
    let host;
    try {
        host = new URL(first).host;
    }
    catch {
        throw new errors_1.GoogleApiError(`Nieprawidlowy URL: ${first}`);
    }
    if (!host)
        throw new errors_1.GoogleApiError(`Nieprawidlowy URL: ${first}`);
    const payload = {
        host,
        key,
        // Protokol dopuszcza maksymalnie 10 000 adresow na zgloszenie.
        urlList: urls.slice(0, 10_000),
    };
    if (keyLocation)
        payload["keyLocation"] = keyLocation;
    const endpoint = ENDPOINTS[engine] ?? ENDPOINTS["generic"];
    let response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30_000),
        });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new errors_1.GoogleApiError(`Blad polaczenia z IndexNow: ${reason}`);
    }
    const body = await response.text().catch(() => "");
    return {
        ok: response.status === 200 || response.status === 202,
        status: response.status,
        message: STATUS_MEANING[response.status] ?? `HTTP ${response.status}`,
        count: urls.length,
        endpoint,
        body: body.slice(0, 500),
    };
}
function keyFileUrl(siteHomeUrl, key) {
    try {
        const parsed = new URL(siteHomeUrl);
        return `${parsed.protocol}//${parsed.host}/${key}.txt`;
    }
    catch {
        return `https://${siteHomeUrl}/${key}.txt`;
    }
}
//# sourceMappingURL=indexnow.js.map