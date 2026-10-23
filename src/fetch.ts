/**
 * Minimal, polite HTTP fetching. The MFM is server-rendered, so a plain GET covers
 * everything the scrape reads: faction pages are requested with `LEGENDS_COOKIE`, so
 * they come back with their Legends, and the rules panels are in every page's RSC
 * payload (see "Source" in specs/scraping.md). Adds a descriptive User-Agent and
 * retry-with-backoff on transient failures. Pacing between pages is the caller's job
 * (the scrape's concurrency pool; `sleep` here is only the inter-retry backoff).
 */

export const BASE_URL = 'https://mfm.warhammer-community.com/en';

const USER_AGENT =
  'wh40k-mfm-scraper (+https://github.com/; data-tracking bot; contact via repo issues)';

export const factionUrl = (slug: string) => `${BASE_URL}/${slug}`;

/**
 * The cookie the site's "Show Legends" toggle sets. A faction page requested with it
 * comes back with the Legends server-rendered, under a `LEGENDS` section heading.
 */
export const LEGENDS_COOKIE = 'isLegendsDisplayed=true';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOptions {
  retries?: number;
  /** Base backoff in ms; doubles each attempt. */
  backoffMs?: number;
  timeoutMs?: number;
  /** A `Cookie` header to send, such as `LEGENDS_COOKIE`. */
  cookie?: string;
}

/** Fetch a URL as text, retrying transient (network / 5xx / 429) failures. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { retries = 3, backoffMs = 1000, timeoutMs = 30_000, cookie } = opts;
  const headers = { 'user-agent': USER_AGENT, accept: 'text/html', ...(cookie ? { cookie } : {}) };
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        if (!res.ok) {
          // 4xx (other than 429) is not worth retrying — fail fast.
          const err = new Error(`HTTP ${res.status} for ${url}`);
          (err as { fatal?: boolean }).fatal = true;
          throw err;
        }
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
      lastError = err;
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts: ${String(lastError)}`);
}
