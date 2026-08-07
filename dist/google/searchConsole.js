"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSites = listSites;
exports.getSite = getSite;
exports.listSitemaps = listSitemaps;
exports.submitSitemap = submitSitemap;
exports.deleteSitemap = deleteSitemap;
exports.inspectUrl = inspectUrl;
exports.searchAnalytics = searchAnalytics;
const http_1 = require("./http");
const WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3";
const SEARCHCONSOLE_BASE = "https://searchconsole.googleapis.com/v1";
async function listSites(accessToken) {
    const data = await (0, http_1.googleRequest)(`${WEBMASTERS_BASE}/sites`, {
        accessToken,
    });
    return data.siteEntry ?? [];
}
function getSite(accessToken, propertyUrl) {
    return (0, http_1.googleRequest)(`${WEBMASTERS_BASE}/sites/${(0, http_1.encodeProperty)(propertyUrl)}`, { accessToken });
}
async function listSitemaps(accessToken, propertyUrl) {
    const data = await (0, http_1.googleRequest)(`${WEBMASTERS_BASE}/sites/${(0, http_1.encodeProperty)(propertyUrl)}/sitemaps`, { accessToken });
    return data.sitemap ?? [];
}
function submitSitemap(accessToken, propertyUrl, feedpath) {
    return (0, http_1.googleRequest)(`${WEBMASTERS_BASE}/sites/${(0, http_1.encodeProperty)(propertyUrl)}/sitemaps/${(0, http_1.encodeProperty)(feedpath)}`, { method: "PUT", accessToken });
}
function deleteSitemap(accessToken, propertyUrl, feedpath) {
    return (0, http_1.googleRequest)(`${WEBMASTERS_BASE}/sites/${(0, http_1.encodeProperty)(propertyUrl)}/sitemaps/${(0, http_1.encodeProperty)(feedpath)}`, { method: "DELETE", accessToken });
}
function inspectUrl(accessToken, propertyUrl, inspectionUrl, languageCode = "pl") {
    return (0, http_1.googleRequest)(`${SEARCHCONSOLE_BASE}/urlInspection/index:inspect`, {
        method: "POST",
        accessToken,
        jsonBody: { inspectionUrl, siteUrl: propertyUrl, languageCode },
    });
}
async function searchAnalytics(accessToken, propertyUrl, startDate, endDate, dimensions = ["date"], rowLimit = 1000) {
    const data = await (0, http_1.googleRequest)(`${WEBMASTERS_BASE}/sites/${(0, http_1.encodeProperty)(propertyUrl)}/searchAnalytics/query`, {
        method: "POST",
        accessToken,
        jsonBody: { startDate, endDate, dimensions, rowLimit },
    });
    return data.rows ?? [];
}
//# sourceMappingURL=searchConsole.js.map