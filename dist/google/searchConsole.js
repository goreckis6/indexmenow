import { encodeProperty, googleRequest } from "./http.js";
const WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3";
const SEARCHCONSOLE_BASE = "https://searchconsole.googleapis.com/v1";
export async function listSites(accessToken) {
    const data = await googleRequest(`${WEBMASTERS_BASE}/sites`, {
        accessToken,
    });
    return data.siteEntry ?? [];
}
export function getSite(accessToken, propertyUrl) {
    return googleRequest(`${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}`, { accessToken });
}
export async function listSitemaps(accessToken, propertyUrl) {
    const data = await googleRequest(`${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}/sitemaps`, { accessToken });
    return data.sitemap ?? [];
}
export function submitSitemap(accessToken, propertyUrl, feedpath) {
    return googleRequest(`${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}/sitemaps/${encodeProperty(feedpath)}`, { method: "PUT", accessToken });
}
export function deleteSitemap(accessToken, propertyUrl, feedpath) {
    return googleRequest(`${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}/sitemaps/${encodeProperty(feedpath)}`, { method: "DELETE", accessToken });
}
export function inspectUrl(accessToken, propertyUrl, inspectionUrl, languageCode = "pl") {
    return googleRequest(`${SEARCHCONSOLE_BASE}/urlInspection/index:inspect`, {
        method: "POST",
        accessToken,
        jsonBody: { inspectionUrl, siteUrl: propertyUrl, languageCode },
    });
}
export async function searchAnalytics(accessToken, propertyUrl, startDate, endDate, dimensions = ["date"], rowLimit = 1000) {
    const data = await googleRequest(`${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}/searchAnalytics/query`, {
        method: "POST",
        accessToken,
        jsonBody: { startDate, endDate, dimensions, rowLimit },
    });
    return data.rows ?? [];
}
//# sourceMappingURL=searchConsole.js.map