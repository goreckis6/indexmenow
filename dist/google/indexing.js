import { googleRequest } from "./http.js";
const PUBLISH_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications:publish";
const METADATA_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications/metadata";
/** Informuje Google, ze adres zostal zmieniony albo usuniety. */
export function publishUrl(accessToken, url, notificationType = "URL_UPDATED") {
    return googleRequest(PUBLISH_ENDPOINT, {
        method: "POST",
        accessToken,
        jsonBody: { url, type: notificationType },
    });
}
export function getUrlMetadata(accessToken, url) {
    return googleRequest(METADATA_ENDPOINT, { accessToken, params: { url } });
}
//# sourceMappingURL=indexing.js.map