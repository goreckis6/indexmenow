export const IndexStatus = {
    UNKNOWN: "UNKNOWN",
    INDEXED: "INDEXED",
    NOT_INDEXED: "NOT_INDEXED",
    EXCLUDED: "EXCLUDED",
    ERROR: "ERROR",
};
export const JobType = {
    URL_UPDATED: "URL_UPDATED",
    URL_DELETED: "URL_DELETED",
    INSPECT: "INSPECT",
    SITEMAP_SUBMIT: "SITEMAP_SUBMIT",
    SITEMAP_DELETE: "SITEMAP_DELETE",
    INDEXNOW: "INDEXNOW",
};
export const JobStatus = {
    PENDING: "PENDING",
    RUNNING: "RUNNING",
    SUCCESS: "SUCCESS",
    FAILED: "FAILED",
    SKIPPED: "SKIPPED",
};
export const Engine = {
    GOOGLE: "google",
    BING: "bing",
    YANDEX: "yandex",
    SEZNAM: "seznam",
    NAVER: "naver",
};
export function isDomainProperty(site) {
    return site.property_url.startsWith("sc-domain:");
}
//# sourceMappingURL=types.js.map