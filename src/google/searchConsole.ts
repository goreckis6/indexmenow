import { encodeProperty, googleRequest } from "./http";

const WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3";
const SEARCHCONSOLE_BASE = "https://searchconsole.googleapis.com/v1";

export interface SiteEntry {
  siteUrl: string;
  permissionLevel?: string;
}

export interface SitemapEntry {
  path: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  lastSubmitted?: string;
  lastDownloaded?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: { type?: string; submitted?: string | number; indexed?: string | number }[];
}

export interface InspectionResult {
  inspectionResult?: {
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      robotsTxtState?: string;
      pageFetchState?: string;
      googleCanonical?: string;
      userCanonical?: string;
      lastCrawlTime?: string;
      indexingState?: string;
      sitemap?: string[];
      referringUrls?: string[];
    };
    mobileUsabilityResult?: { verdict?: string };
    richResultsResult?: { verdict?: string };
    inspectionResultLink?: string;
  };
}

export async function listSites(accessToken: string): Promise<SiteEntry[]> {
  const data = await googleRequest<{ siteEntry?: SiteEntry[] }>(`${WEBMASTERS_BASE}/sites`, {
    accessToken,
  });
  return data.siteEntry ?? [];
}

export function getSite(accessToken: string, propertyUrl: string): Promise<SiteEntry> {
  return googleRequest<SiteEntry>(
    `${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}`,
    { accessToken },
  );
}

export async function listSitemaps(
  accessToken: string,
  propertyUrl: string,
): Promise<SitemapEntry[]> {
  const data = await googleRequest<{ sitemap?: SitemapEntry[] }>(
    `${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}/sitemaps`,
    { accessToken },
  );
  return data.sitemap ?? [];
}

export function submitSitemap(
  accessToken: string,
  propertyUrl: string,
  feedpath: string,
): Promise<unknown> {
  return googleRequest(
    `${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}/sitemaps/${encodeProperty(feedpath)}`,
    { method: "PUT", accessToken },
  );
}

export function deleteSitemap(
  accessToken: string,
  propertyUrl: string,
  feedpath: string,
): Promise<unknown> {
  return googleRequest(
    `${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}/sitemaps/${encodeProperty(feedpath)}`,
    { method: "DELETE", accessToken },
  );
}

export function inspectUrl(
  accessToken: string,
  propertyUrl: string,
  inspectionUrl: string,
  languageCode = "pl",
): Promise<InspectionResult> {
  return googleRequest<InspectionResult>(`${SEARCHCONSOLE_BASE}/urlInspection/index:inspect`, {
    method: "POST",
    accessToken,
    jsonBody: { inspectionUrl, siteUrl: propertyUrl, languageCode },
  });
}

export interface AnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export async function searchAnalytics(
  accessToken: string,
  propertyUrl: string,
  startDate: string,
  endDate: string,
  dimensions: string[] = ["date"],
  rowLimit = 1000,
): Promise<AnalyticsRow[]> {
  const data = await googleRequest<{ rows?: AnalyticsRow[] }>(
    `${WEBMASTERS_BASE}/sites/${encodeProperty(propertyUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      accessToken,
      jsonBody: { startDate, endDate, dimensions, rowLimit },
    },
  );
  return data.rows ?? [];
}
