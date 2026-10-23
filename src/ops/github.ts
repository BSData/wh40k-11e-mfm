import { sleep } from '../fetch.js';

/**
 * The few GitHub REST calls the scrape workflow makes, as plain `fetch` against
 * `GITHUB_API_URL`. They used to be `gh` and `github-script` inside the workflow, where
 * they only ever ran in production; here a test points them at a stub server, so the
 * code the tests drive is the code that ships.
 */

export interface GitHub {
  /** The REST API root: `https://api.github.com`, or a stub server's. */
  api: string;
  /** The web root, for links: `https://github.com`. */
  server: string;
  /** `owner/name`. */
  repo: string;
  token: string;
  /** The first retry's wait, doubling after (default 1 s); tests set 0. */
  retryDelayMs?: number;
}

/** An environment variable; an empty one counts as unset. */
const read = (env: NodeJS.ProcessEnv, name: string) => env[name] || undefined;

/** The repository a workflow runs for, from the variables Actions sets (and `GH_TOKEN`). */
export function githubFromEnv(env: NodeJS.ProcessEnv = process.env): GitHub {
  const get = (name: string) => read(env, name);
  const repo = get('GITHUB_REPOSITORY');
  const token = get('GH_TOKEN') ?? get('GITHUB_TOKEN');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('GITHUB_REPOSITORY must name the repository as owner/name');
  }
  if (!token) throw new Error('GH_TOKEN is not set');
  const root = (url: string) => url.replace(/\/+$/, '');
  return {
    api: root(get('GITHUB_API_URL') ?? 'https://api.github.com'),
    server: root(get('GITHUB_SERVER_URL') ?? 'https://github.com'),
    repo,
    token,
  };
}

/** The current workflow run's page, for a link a person can follow. */
export function runUrl(gh: GitHub, env: NodeJS.ProcessEnv = process.env): string {
  const id = read(env, 'GITHUB_RUN_ID');
  if (!id || !/^\d+$/.test(id)) throw new Error('GITHUB_RUN_ID is not set');
  return `${gh.server}/${gh.repo}/actions/runs/${id}`;
}

const repoUrl = (gh: GitHub, path: string) => `${gh.api}/repos/${gh.repo}${path}`;

/** Tries per call: these calls are how a failed scrape gets reported, so a blip mustn't lose one. */
const ATTEMPTS = 3;
/** Statuses that usually mean GitHub didn't act on the request, so any method retries. */
const NOT_SERVED = new Set([429, 502, 503, 504]);
/** The longest wait between tries: a longer `Retry-After` is cut to this, not obeyed. */
const MAX_WAIT_MS = 60_000;

/**
 * One HTTP call, retried on a network error, a 429 or a 502–504, and for a GET (which is
 * safe to repeat) on any 5xx; never on a 500 to a write, which likely made the comment
 * or the issue. A 502–504 or a dropped connection doesn't prove GitHub didn't act either,
 * so a retried write can, rarely, comment or open an issue twice: better than a failure
 * report lost, and the next run tidies up (it closes every open failure issue). Waits
 * `Retry-After` when GitHub sends one, at most a minute, else 1 s, then 2 s.
 */
async function call(gh: GitHub, method: string, url: string, body?: unknown): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${gh.token}`,
          'user-agent': 'wh40k-mfm-scraper',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
    }
    if (res?.ok) return res;
    if (res) {
      const transient = NOT_SERVED.has(res.status) || (method === 'GET' && res.status >= 500);
      if (!transient || attempt >= ATTEMPTS) {
        throw new Error(`GitHub ${method} ${url}: HTTP ${res.status} ${await res.text()}`);
      }
    }
    const after = Number(res?.headers.get('retry-after')) * 1000;
    const backoff = (gh.retryDelayMs ?? 1000) * 2 ** (attempt - 1);
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_WAIT_MS) : backoff);
  }
}

/** One call on the repository: `path` is relative to `/repos/<owner>/<name>`. */
export async function request<T>(
  gh: GitHub,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await call(gh, method, repoUrl(gh, path), body);
  return (await res.json()) as T;
}

/**
 * Every page of a list on the repository, following `Link: rel="next"`. Only to the API's
 * own origin: the token goes with each request.
 */
export async function paginate<T>(gh: GitHub, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = repoUrl(gh, path);
  while (next) {
    const res = await call(gh, 'GET', next);
    out.push(...((await res.json()) as T[]));
    next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    if (next && new URL(next).origin !== new URL(gh.api).origin) {
      throw new Error(`GitHub paginated to another host: ${next}`);
    }
  }
  return out;
}
