import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/** Kolumna ustawiana przez baze przy wstawianiu, ktorej nie podajemy w INSERT. */
type CreatedAt = ColumnType<Date, Date | undefined, never>;
type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;

export const IndexStatus = {
  UNKNOWN: "UNKNOWN",
  INDEXED: "INDEXED",
  NOT_INDEXED: "NOT_INDEXED",
  EXCLUDED: "EXCLUDED",
  ERROR: "ERROR",
} as const;
export type IndexStatus = (typeof IndexStatus)[keyof typeof IndexStatus];

export const JobType = {
  URL_UPDATED: "URL_UPDATED",
  URL_DELETED: "URL_DELETED",
  INSPECT: "INSPECT",
  SITEMAP_SUBMIT: "SITEMAP_SUBMIT",
  SITEMAP_DELETE: "SITEMAP_DELETE",
  INDEXNOW: "INDEXNOW",
} as const;
export type JobType = (typeof JobType)[keyof typeof JobType];

export const JobStatus = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const Engine = {
  GOOGLE: "google",
  BING: "bing",
  YANDEX: "yandex",
  SEZNAM: "seznam",
  NAVER: "naver",
} as const;
export type Engine = (typeof Engine)[keyof typeof Engine];

export interface UsersTable {
  id: Generated<number>;
  google_sub: string;
  email: string;
  name: Nullable<string>;
  picture: Nullable<string>;
  locale: Nullable<string>;
  is_admin: ColumnType<boolean, boolean | undefined, boolean>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  last_login_at: Nullable<Date>;
}

export interface GoogleCredentialsTable {
  id: Generated<number>;
  user_id: number;
  access_token_enc: string;
  refresh_token_enc: Nullable<string>;
  token_type: ColumnType<string, string | undefined, string>;
  scopes: ColumnType<string, string | undefined, string>;
  expires_at: Nullable<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface WorkspacesTable {
  id: Generated<number>;
  user_id: number;
  name: string;
  slug: string;
  daily_quota: ColumnType<number, number | undefined, number>;
  auto_index_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  email_reports: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
}

export interface ServiceAccountsTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  client_email: string;
  project_id: Nullable<string>;
  private_key_id: Nullable<string>;
  private_key_enc: string;
  daily_quota: ColumnType<number, number | undefined, number>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  last_used_at: Nullable<Date>;
  created_at: CreatedAt;
}

export interface SitesTable {
  id: Generated<number>;
  workspace_id: number;
  /** Wlasciwosc Search Console, np. "https://example.com/" albo "sc-domain:example.com". */
  property_url: string;
  display_name: string;
  home_url: string;
  permission_level: Nullable<string>;
  auto_index: ColumnType<boolean, boolean | undefined, boolean>;
  priority: ColumnType<number, number | undefined, number>;
  daily_limit: ColumnType<number, number | undefined, number>;
  indexnow_key: Nullable<string>;
  indexnow_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  last_scan_at: Nullable<Date>;
  last_index_run_at: Nullable<Date>;
  created_at: CreatedAt;
}

export interface SitemapsTable {
  id: Generated<number>;
  site_id: number;
  path: string;
  /** SHA-256 sciezki - MySQL nie zindeksuje unikalnie calego VARCHAR(1024) w utf8mb4. */
  path_hash: string;
  source: ColumnType<string, string | undefined, string>;
  is_pending: ColumnType<boolean, boolean | undefined, boolean>;
  is_sitemaps_index: ColumnType<boolean, boolean | undefined, boolean>;
  url_count: ColumnType<number, number | undefined, number>;
  warnings: ColumnType<number, number | undefined, number>;
  errors: ColumnType<number, number | undefined, number>;
  last_submitted_at: Nullable<Date>;
  last_downloaded_at: Nullable<Date>;
  auto_sync: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
}

export interface UrlsTable {
  id: Generated<number>;
  site_id: number;
  url: string;
  /** SHA-256 adresu, zeby unikalnosc dzialala na pelnej dlugosci URL-a. */
  url_hash: string;
  source: ColumnType<string, string | undefined, string>;
  index_status: ColumnType<IndexStatus, IndexStatus | undefined, IndexStatus>;
  coverage_state: Nullable<string>;
  robots_state: Nullable<string>;
  page_fetch_state: Nullable<string>;
  canonical_google: Nullable<string>;
  canonical_user: Nullable<string>;
  verdict: Nullable<string>;
  last_crawl_at: Nullable<Date>;
  last_checked_at: Nullable<Date>;
  last_submitted_at: Nullable<Date>;
  submit_count: ColumnType<number, number | undefined, number>;
  priority: ColumnType<number, number | undefined, number>;
  lastmod: Nullable<Date>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  error_message: Nullable<string>;
  created_at: CreatedAt;
}

export interface IndexJobsTable {
  id: Generated<number>;
  site_id: number;
  url_id: Nullable<number>;
  target: string;
  job_type: ColumnType<JobType, JobType | undefined, JobType>;
  engine: ColumnType<Engine, Engine | undefined, Engine>;
  status: ColumnType<JobStatus, JobStatus | undefined, JobStatus>;
  triggered_by: ColumnType<string, string | undefined, string>;
  message: Nullable<string>;
  payload: Nullable<unknown>;
  duration_ms: Nullable<number>;
  created_at: CreatedAt;
  finished_at: Nullable<Date>;
}

export interface QuotaUsageTable {
  id: Generated<number>;
  workspace_id: number;
  /** Przechowywane jako DATE, wiec operujemy na "RRRR-MM-DD". */
  day: string;
  engine: ColumnType<Engine, Engine | undefined, Engine>;
  used: ColumnType<number, number | undefined, number>;
}

export interface SiteStatsTable {
  id: Generated<number>;
  site_id: number;
  day: string;
  total_urls: ColumnType<number, number | undefined, number>;
  indexed: ColumnType<number, number | undefined, number>;
  not_indexed: ColumnType<number, number | undefined, number>;
  submitted: ColumnType<number, number | undefined, number>;
  inspected: ColumnType<number, number | undefined, number>;
}

export interface ActivityLogTable {
  id: Generated<number>;
  workspace_id: Nullable<number>;
  level: ColumnType<string, string | undefined, string>;
  category: ColumnType<string, string | undefined, string>;
  message: string;
  details: Nullable<unknown>;
  created_at: CreatedAt;
}

export interface SchedulerLockTable {
  name: string;
  owner: string;
  acquired_at: Date;
  heartbeat_at: Date;
}

export interface Database {
  scheduler_lock: SchedulerLockTable;
  users: UsersTable;
  google_credentials: GoogleCredentialsTable;
  workspaces: WorkspacesTable;
  service_accounts: ServiceAccountsTable;
  sites: SitesTable;
  sitemaps: SitemapsTable;
  urls: UrlsTable;
  index_jobs: IndexJobsTable;
  quota_usage: QuotaUsageTable;
  site_stats: SiteStatsTable;
  activity_log: ActivityLogTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type GoogleCredential = Selectable<GoogleCredentialsTable>;
export type Workspace = Selectable<WorkspacesTable>;
export type ServiceAccount = Selectable<ServiceAccountsTable>;
export type Site = Selectable<SitesTable>;
export type Sitemap = Selectable<SitemapsTable>;
export type PageUrl = Selectable<UrlsTable>;
export type IndexJob = Selectable<IndexJobsTable>;
export type SiteStat = Selectable<SiteStatsTable>;
export type ActivityEntry = Selectable<ActivityLogTable>;

export function isDomainProperty(site: Pick<Site, "property_url">): boolean {
  return site.property_url.startsWith("sc-domain:");
}
