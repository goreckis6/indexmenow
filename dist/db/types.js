"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Engine = exports.JobStatus = exports.JobType = exports.IndexStatus = void 0;
exports.isDomainProperty = isDomainProperty;
exports.IndexStatus = {
    UNKNOWN: "UNKNOWN",
    INDEXED: "INDEXED",
    NOT_INDEXED: "NOT_INDEXED",
    EXCLUDED: "EXCLUDED",
    ERROR: "ERROR",
};
exports.JobType = {
    URL_UPDATED: "URL_UPDATED",
    URL_DELETED: "URL_DELETED",
    INSPECT: "INSPECT",
    SITEMAP_SUBMIT: "SITEMAP_SUBMIT",
    SITEMAP_DELETE: "SITEMAP_DELETE",
    INDEXNOW: "INDEXNOW",
};
exports.JobStatus = {
    PENDING: "PENDING",
    RUNNING: "RUNNING",
    SUCCESS: "SUCCESS",
    FAILED: "FAILED",
    SKIPPED: "SKIPPED",
};
exports.Engine = {
    GOOGLE: "google",
    BING: "bing",
    YANDEX: "yandex",
    SEZNAM: "seznam",
    NAVER: "naver",
};
function isDomainProperty(site) {
    return site.property_url.startsWith("sc-domain:");
}
//# sourceMappingURL=types.js.map