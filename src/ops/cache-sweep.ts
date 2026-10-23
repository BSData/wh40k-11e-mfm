import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Deletes every Actions cache entry created since a time: `drift-fix.yml`'s `caches` job
 * runs it after the agent's job, in which code a model wrote held the Actions runtime
 * token for main and could write entries that later runs restore (see "No dependency
 * cache" in specs/change-tracking.md). That job holds `actions: write`, so, like
 * agent-patch.ts, this imports only Node's own modules and runs under plain Node with no
 * node_modules; a test holds it to that.
 *
 * It lists the entries newest first by creation (`sort=created_at`), page by page until
 * one older than the cutoff, so a flood of later entries can't push one off the list;
 * deletes them; and goes round again until a pass finds none. Whatever it can't delete is
 * a failure: the caller's job fails, and the draft PR waits.
 */

export interface Api {
  /** The REST API root, `https://api.github.com`, or a stub's. */
  root: string;
  /** `owner/name`. */
  repo: string;
  token: string;
  /** The first retry's wait, doubling after (default 1 s); tests set 0. */
  retryDelayMs?: number;
}

interface CacheEntry {
  id: number;
  key: string;
  created_at: string;
}

const PER_PAGE = 100;
/** Passes over the list before giving up on entries that keep appearing. */
const MAX_PASSES = 10;

async function call(api: Api, method: string, path: string): Promise<Response> {
  const url = `${api.root}/repos/${api.repo}${path}`;
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${api.token}`,
          'user-agent': 'wh40k-mfm-scraper',
          'x-github-api-version': '2022-11-28',
        },
      });
    } catch (err) {
      if (attempt >= 3) throw err;
    }
    if (res && (res.ok || res.status === 404 || (res.status < 500 && res.status !== 429))) {
      return res;
    }
    if (attempt >= 3) {
      throw new Error(`GitHub ${method} ${path}: HTTP ${res?.status} ${await res?.text()}`);
    }
    await new Promise((done) => setTimeout(done, (api.retryDelayMs ?? 1000) * 2 ** (attempt - 1)));
  }
}

/** The entries created at or after `since`, newest first, however many there are. */
export async function entriesSince(api: Api, since: Date): Promise<CacheEntry[]> {
  const found: CacheEntry[] = [];
  for (let page = 1; ; page++) {
    const res = await call(
      api,
      'GET',
      `/actions/caches?sort=created_at&direction=desc&per_page=${PER_PAGE}&page=${page}`,
    );
    if (!res.ok)
      throw new Error(`GitHub GET /actions/caches: HTTP ${res.status} ${await res.text()}`);
    const { actions_caches: entries } = (await res.json()) as { actions_caches: CacheEntry[] };
    for (const entry of entries) {
      if (Date.parse(entry.created_at) < since.getTime()) return found;
      found.push(entry);
    }
    if (entries.length < PER_PAGE) return found;
  }
}

export interface Sweep {
  deleted: number;
  /** Entries still there, or that failed to delete, when it gave up. */
  left: CacheEntry[];
}

/** Delete every entry created since `since`, pass after pass, until a pass finds none. */
export async function sweepCaches(
  api: Api,
  since: Date,
  log: (line: string) => void = () => {},
): Promise<Sweep> {
  let deleted = 0;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const entries = await entriesSince(api, since);
    if (entries.length === 0) return { deleted, left: [] };
    const failed: CacheEntry[] = [];
    for (const entry of entries) {
      const res = await call(api, 'DELETE', `/actions/caches/${entry.id}`);
      // 404: gone already, which is what was wanted.
      if (res.ok || res.status === 404) {
        deleted++;
        log(`Deleted cache ${entry.id} (${entry.key}), created ${entry.created_at}`);
      } else {
        failed.push(entry);
        log(`Couldn't delete cache ${entry.id}: HTTP ${res.status} ${await res.text()}`);
      }
    }
    if (failed.length > 0) return { deleted, left: failed };
  }
  return { deleted, left: await entriesSince(api, since) };
}

/** Run from the command line; resolves to the exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { since: { type: 'string' } } });
  const since = values.since ?? '';
  const { GITHUB_API_URL = 'https://api.github.com', GITHUB_REPOSITORY = '', GH_TOKEN = '' } = env;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(since) || Number.isNaN(Date.parse(since))) {
    process.stderr.write(
      `usage: cache-sweep.ts --since <YYYY-MM-DDTHH:MM:SSZ>, not ${JSON.stringify(since)}\n`,
    );
    return 2;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY) || !GH_TOKEN) {
    process.stderr.write('cache-sweep.ts needs GITHUB_REPOSITORY and GH_TOKEN\n');
    return 2;
  }
  const api = {
    root: GITHUB_API_URL.replace(/\/+$/, ''),
    repo: GITHUB_REPOSITORY,
    token: GH_TOKEN,
  };
  const { deleted, left } = await sweepCaches(api, new Date(since), (line) =>
    process.stdout.write(`${line}\n`),
  );
  process.stdout.write(`Deleted ${deleted} cache entries created since ${since}.\n`);
  if (left.length > 0) {
    process.stderr.write(
      `::error title=Caches left::${left.length} cache entries created since ${since} are still there: ${left.map((e) => e.id).join(', ')}\n`,
    );
    return 1;
  }
  return 0;
}

// Run when executed, not when imported (the tests import it).
const entry = process.argv[1];
if (
  entry &&
  existsSync(entry) &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`::error::${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
