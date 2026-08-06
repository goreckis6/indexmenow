import { sql } from "kysely";
import { db } from ".";

/**
 * Schemat tworzony przy starcie aplikacji.
 *
 * Dwie rzeczy rozniace sie od wersji na SQLite:
 *
 * 1. InnoDB pozwala na indeks o dlugosci do 3072 bajtow, a w utf8mb4 jeden znak
 *    zajmuje do 4 bajtow. VARCHAR(2048) po prostu sie nie zmiesci, dlatego
 *    unikalnosc adresow i sciezek sitemap opiera sie na kolumnach z SHA-256.
 * 2. Nie ma tu typu boolean - TINYINT(1) jest konwertowany na boolean
 *    w konfiguracji puli mysql2.
 */
const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    google_sub VARCHAR(64) NOT NULL,
    email VARCHAR(320) NOT NULL,
    name VARCHAR(255) NULL,
    picture VARCHAR(512) NULL,
    locale VARCHAR(16) NULL,
    is_admin TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL,
    UNIQUE KEY uq_users_google_sub (google_sub),
    UNIQUE KEY uq_users_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS google_credentials (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT NULL,
    token_type VARCHAR(32) NOT NULL DEFAULT 'Bearer',
    scopes TEXT NOT NULL,
    expires_at DATETIME NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_credentials_user (user_id),
    CONSTRAINT fk_credentials_user FOREIGN KEY (user_id)
      REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS workspaces (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL,
    slug VARCHAR(140) NOT NULL,
    daily_quota INT NOT NULL DEFAULT 200,
    auto_index_enabled TINYINT(1) NOT NULL DEFAULT 1,
    email_reports TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_workspaces_user (user_id),
    KEY ix_workspaces_slug (slug),
    CONSTRAINT fk_workspaces_user FOREIGN KEY (user_id)
      REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS service_accounts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    client_email VARCHAR(320) NOT NULL,
    project_id VARCHAR(160) NULL,
    private_key_id VARCHAR(80) NULL,
    private_key_enc TEXT NOT NULL,
    daily_quota INT NOT NULL DEFAULT 200,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    last_used_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_service_accounts_workspace (workspace_id),
    CONSTRAINT fk_service_accounts_workspace FOREIGN KEY (workspace_id)
      REFERENCES workspaces (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS sites (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT UNSIGNED NOT NULL,
    property_url VARCHAR(512) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    home_url VARCHAR(512) NOT NULL,
    permission_level VARCHAR(64) NULL,
    auto_index TINYINT(1) NOT NULL DEFAULT 0,
    priority INT NOT NULL DEFAULT 0,
    daily_limit INT NOT NULL DEFAULT 50,
    indexnow_key VARCHAR(64) NULL,
    indexnow_enabled TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    last_scan_at DATETIME NULL,
    last_index_run_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_site_property (workspace_id, property_url),
    CONSTRAINT fk_sites_workspace FOREIGN KEY (workspace_id)
      REFERENCES workspaces (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS sitemaps (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    site_id INT UNSIGNED NOT NULL,
    path VARCHAR(1024) NOT NULL,
    path_hash CHAR(64) NOT NULL,
    source VARCHAR(16) NOT NULL DEFAULT 'manual',
    is_pending TINYINT(1) NOT NULL DEFAULT 0,
    is_sitemaps_index TINYINT(1) NOT NULL DEFAULT 0,
    url_count INT NOT NULL DEFAULT 0,
    warnings INT NOT NULL DEFAULT 0,
    errors INT NOT NULL DEFAULT 0,
    last_submitted_at DATETIME NULL,
    last_downloaded_at DATETIME NULL,
    auto_sync TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sitemap_path (site_id, path_hash),
    CONSTRAINT fk_sitemaps_site FOREIGN KEY (site_id)
      REFERENCES sites (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS urls (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    site_id INT UNSIGNED NOT NULL,
    url VARCHAR(2048) NOT NULL,
    url_hash CHAR(64) NOT NULL,
    source VARCHAR(16) NOT NULL DEFAULT 'manual',
    index_status VARCHAR(24) NOT NULL DEFAULT 'UNKNOWN',
    coverage_state VARCHAR(255) NULL,
    robots_state VARCHAR(64) NULL,
    page_fetch_state VARCHAR(64) NULL,
    canonical_google VARCHAR(2048) NULL,
    canonical_user VARCHAR(2048) NULL,
    verdict VARCHAR(32) NULL,
    last_crawl_at DATETIME NULL,
    last_checked_at DATETIME NULL,
    last_submitted_at DATETIME NULL,
    submit_count INT NOT NULL DEFAULT 0,
    priority INT NOT NULL DEFAULT 0,
    lastmod DATETIME NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    error_message TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_site_url (site_id, url_hash),
    KEY ix_urls_status (index_status),
    KEY ix_urls_last_checked (last_checked_at),
    CONSTRAINT fk_urls_site FOREIGN KEY (site_id)
      REFERENCES sites (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS index_jobs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    site_id INT UNSIGNED NOT NULL,
    url_id INT UNSIGNED NULL,
    target VARCHAR(2048) NOT NULL,
    job_type VARCHAR(24) NOT NULL DEFAULT 'URL_UPDATED',
    engine VARCHAR(16) NOT NULL DEFAULT 'google',
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    triggered_by VARCHAR(16) NOT NULL DEFAULT 'manual',
    message TEXT NULL,
    payload JSON NULL,
    duration_ms DOUBLE NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    KEY ix_jobs_site (site_id),
    KEY ix_jobs_url (url_id),
    KEY ix_jobs_status (status),
    KEY ix_jobs_created (created_at),
    CONSTRAINT fk_jobs_site FOREIGN KEY (site_id)
      REFERENCES sites (id) ON DELETE CASCADE,
    CONSTRAINT fk_jobs_url FOREIGN KEY (url_id)
      REFERENCES urls (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS quota_usage (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT UNSIGNED NOT NULL,
    day DATE NOT NULL,
    engine VARCHAR(16) NOT NULL DEFAULT 'google',
    used INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_quota_day_engine (workspace_id, day, engine),
    KEY ix_quota_day (day),
    CONSTRAINT fk_quota_workspace FOREIGN KEY (workspace_id)
      REFERENCES workspaces (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS site_stats (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    site_id INT UNSIGNED NOT NULL,
    day DATE NOT NULL,
    total_urls INT NOT NULL DEFAULT 0,
    indexed INT NOT NULL DEFAULT 0,
    not_indexed INT NOT NULL DEFAULT 0,
    submitted INT NOT NULL DEFAULT 0,
    inspected INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_sitestat_day (site_id, day),
    KEY ix_sitestat_day (day),
    CONSTRAINT fk_sitestats_site FOREIGN KEY (site_id)
      REFERENCES sites (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS activity_log (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT UNSIGNED NULL,
    level VARCHAR(16) NOT NULL DEFAULT 'info',
    category VARCHAR(32) NOT NULL DEFAULT 'system',
    message TEXT NOT NULL,
    details JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_activity_workspace (workspace_id),
    KEY ix_activity_created (created_at),
    CONSTRAINT fk_activity_workspace FOREIGN KEY (workspace_id)
      REFERENCES workspaces (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /**
   * Blokada dla schedulera. Zarzadzany hosting moze trzymac kilka instancji
   * aplikacji naraz, a wtedy kazda probowalaby zglaszac te same URL-e.
   * Instancja przedluza wpis co minute; wygasla blokade moze przejac inna.
   */
  `CREATE TABLE IF NOT EXISTS scheduler_lock (
    name VARCHAR(64) NOT NULL PRIMARY KEY,
    owner VARCHAR(64) NOT NULL,
    acquired_at DATETIME NOT NULL,
    heartbeat_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export async function migrate(): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
