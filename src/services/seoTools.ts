import * as cheerio from "cheerio";

const USER_AGENT = "IndexMeNow/1.0 (+seo-tools)";
const TIMEOUT_MS = 20_000;

export interface SeoIssue {
  level: "error" | "warning" | "info" | "success";
  text: string;
}

export interface PageMeta {
  url: string;
  error?: string;
  final_url?: string;
  status_code?: number;
  elapsed_ms?: number;
  size_kb?: number;
  title?: string | null;
  description?: string | null;
  robots?: string | null;
  canonical?: string | null;
  favicon?: string | null;
  h1?: string | null;
  lang?: string | null;
  og?: Record<string, string | null>;
  twitter?: Record<string, string | null>;
  issues?: SeoIssue[];
}

function absolute(base: string, href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export async function fetchPageMeta(url: string): Promise<PageMeta> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { url, error: `Nie udalo sie pobrac strony: ${reason}` };
  }

  const body = await response.arrayBuffer();
  const html = Buffer.from(body).toString("utf8");
  const elapsedMs = Date.now() - started;
  const finalUrl = response.url || url;
  const $ = cheerio.load(html);

  const meta = (name: string, attr: "name" | "property" = "name"): string | null => {
    const content = $(`meta[${attr}="${name}"]`).first().attr("content");
    return content?.trim() || null;
  };

  const title = $("title").first().text().trim() || null;
  const h1 = $("h1").first().text().trim() || null;
  const canonical = $('link[rel~="canonical"]').first().attr("href") ?? null;
  const iconHref = $('link[rel~="icon"], link[rel~="shortcut"]').first().attr("href");
  const robots = meta("robots");
  const description = meta("description");
  const ogImage = meta("og:image", "property");

  const issues = collectIssues({
    status: response.status,
    title,
    description,
    robots,
    canonical,
    ogImage,
    hasH1: Boolean(h1),
  });

  return {
    url,
    final_url: finalUrl,
    status_code: response.status,
    elapsed_ms: elapsedMs,
    size_kb: Math.round((body.byteLength / 1024) * 10) / 10,
    title,
    description,
    robots,
    canonical,
    favicon: absolute(finalUrl, iconHref),
    h1,
    lang: $("html").attr("lang") ?? null,
    og: {
      title: meta("og:title", "property"),
      description: meta("og:description", "property"),
      image: absolute(finalUrl, ogImage),
      site_name: meta("og:site_name", "property"),
      type: meta("og:type", "property"),
      url: meta("og:url", "property"),
    },
    twitter: {
      card: meta("twitter:card"),
      title: meta("twitter:title"),
      description: meta("twitter:description"),
      image: absolute(finalUrl, meta("twitter:image") ?? meta("twitter:image", "property")),
      site: meta("twitter:site"),
    },
    issues,
  };
}

interface IssueInput {
  status: number;
  title: string | null;
  description: string | null;
  robots: string | null;
  canonical: string | null;
  ogImage: string | null;
  hasH1: boolean;
}

function collectIssues(input: IssueInput): SeoIssue[] {
  const issues: SeoIssue[] = [];

  if (input.status >= 400) {
    issues.push({ level: "error", text: `Strona zwraca kod HTTP ${input.status}.` });
  }

  if (!input.title) {
    issues.push({ level: "error", text: "Brak znacznika <title>." });
  } else if (input.title.length > 60) {
    issues.push({
      level: "warning",
      text: `Tytul ma ${input.title.length} znakow - Google utnie go w wynikach.`,
    });
  } else if (input.title.length < 20) {
    issues.push({ level: "warning", text: "Tytul jest bardzo krotki (<20 znakow)." });
  }

  if (!input.description) {
    issues.push({ level: "warning", text: "Brak meta description." });
  } else if (input.description.length > 160) {
    issues.push({
      level: "warning",
      text: `Opis ma ${input.description.length} znakow - zalecane do 160.`,
    });
  }

  const robots = (input.robots ?? "").toLowerCase();
  if (robots.includes("noindex")) {
    issues.push({
      level: "error",
      text: "Strona ma dyrektywe noindex - Google jej nie zaindeksuje.",
    });
  }
  if (robots.includes("nofollow")) {
    issues.push({ level: "warning", text: "Strona ma dyrektywe nofollow." });
  }

  if (!input.canonical) issues.push({ level: "warning", text: "Brak tagu canonical." });
  if (!input.ogImage) {
    issues.push({
      level: "info",
      text: "Brak og:image - linki nie beda mialy podgladu grafiki.",
    });
  }
  if (!input.hasH1) issues.push({ level: "warning", text: "Brak naglowka H1." });

  if (issues.length === 0) {
    issues.push({ level: "success", text: "Nie wykryto podstawowych problemow SEO." });
  }
  return issues;
}
