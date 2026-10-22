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

async function call(gh: GitHub, method: string, url: string, body?: unknown): Promise<Response> {
  const res = await fetch(url, {
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
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${url}: HTTP ${res.status} ${await res.text()}`);
  }
  return res;
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
