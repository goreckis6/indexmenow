"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishUrl = publishUrl;
exports.getUrlMetadata = getUrlMetadata;
const http_1 = require("./http");
const PUBLISH_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications:publish";
const METADATA_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications/metadata";
/** Informuje Google, ze adres zostal zmieniony albo usuniety. */
function publishUrl(accessToken, url, notificationType = "URL_UPDATED") {
    return (0, http_1.googleRequest)(PUBLISH_ENDPOINT, {
        method: "POST",
        accessToken,
        jsonBody: { url, type: notificationType },
    });
}
function getUrlMetadata(accessToken, url) {
    return (0, http_1.googleRequest)(METADATA_ENDPOINT, { accessToken, params: { url } });
}
//# sourceMappingURL=indexing.js.map