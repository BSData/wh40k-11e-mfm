import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscordMessage } from '../src/discord.js';
import { announceOnPr, markerComment, recordedMessageId } from '../src/ops/announce.js';
import { failureReport, reportFailure, resolveFailure } from '../src/ops/failure-issue.js';
import { type GitHub, githubFromEnv, paginate, request, runUrl } from '../src/ops/github.js';
import { exportBranchData, exportOpenPrs, gitEnv, listUpdatePrs } from '../src/ops/open-prs.js';
import { stepOutputs } from '../src/ops/outputs.js';

interface Call {
  method: string;
  path: string;
  body: string;
  auth: string | undefined;
}

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  servers.length = 0;
});

/**
 * A stand-in for an HTTP API: GitHub's REST API, or a Discord webhook. Every request is
 * recorded, and `reply` answers it (200 with `{}` by default).
 */
async function stub(reply: (call: Call) => Reply = () => ({})) {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const call = {
        method: req.method ?? '',
        path: req.url ?? '',
        body,
        auth: req.headers.authorization,
      };
      calls.push(call);
      const r = reply(call);
      res
        .writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers })
        .end(JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls };
}

const REPO = 'BSData/wh40k-11e-mfm';
const github = (api: string): GitHub => ({
  api,
  server: 'https://github.com',
  repo: REPO,
  token: 't0ken',
  retryDelayMs: 0,
});
const RUN = 'https://github.com/BSData/wh40k-11e-mfm/actions/runs/42';

/** The writes a stub received, as `METHOD path` and the parsed body. */
const writes = (calls: Call[]) =>
  calls
    .filter((c) => c.method !== 'GET')
    .map((c) => ({ call: `${c.method} ${c.path}`, body: JSON.parse(c.body || '{}') }));

describe('githubFromEnv', () => {
  const env = {
    GITHUB_REPOSITORY: REPO,
    GH_TOKEN: 't0ken',
    GITHUB_API_URL: 'http://127.0.0.1:1/',
    GITHUB_RUN_ID: '42',
  };

  it('reads the repository, the token and the API root that Actions provides', () => {
    expect(githubFromEnv(env)).toEqual({
      api: 'http://127.0.0.1:1',
      server: 'https://github.com',
      repo: REPO,
      token: 't0ken',
    });
    expect(runUrl(githubFromEnv(env), env)).toBe(RUN);
  });

  it('falls back to GITHUB_TOKEN and to the public API', () => {
    const gh = githubFromEnv({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'other' });
    expect(gh).toMatchObject({ api: 'https://api.github.com', token: 'other' });
  });

  it.each([
    [{ ...env, GITHUB_REPOSITORY: '' }, /GITHUB_REPOSITORY/],
    [{ ...env, GITHUB_REPOSITORY: 'BSData/../x/y' }, /GITHUB_REPOSITORY/],
    [{ ...env, GH_TOKEN: '' }, /GH_TOKEN/],
  ])('refuses an incomplete environment', (e, message) => {
    expect(() => githubFromEnv(e)).toThrow(message);
  });

  it('needs a numeric run id to link the run', () => {
    expect(() => runUrl(githubFromEnv(env), { ...env, GITHUB_RUN_ID: 'x' })).toThrow(
      /GITHUB_RUN_ID/,
    );
  });
});

describe('paginate', () => {
  it('follows rel="next" and sends the token with every page', async () => {
    const api = await stub((call) =>
      call.path.includes('page=2')
        ? { body: [{ n: 2 }] }
        : {
            body: [{ n: 1 }],
            headers: { link: `<${api.url}/repos/${REPO}/issues?page=2>; rel="next"` },
          },
    );
    await expect(paginate(github(api.url), '/issues')).resolves.toEqual([{ n: 1 }, { n: 2 }]);
    expect(api.calls.map((c) => c.auth)).toEqual(['Bearer t0ken', 'Bearer t0ken']);
  });

  it('does not follow a next page to another host, where the token would go too', async () => {
    const api = await stub(() => ({
      body: [],
      headers: { link: '<https://elsewhere.invalid/repos?page=2>; rel="next"' },
    }));
    await expect(paginate(github(api.url), '/issues')).rejects.toThrow(/another host/);
    expect(api.calls).toHaveLength(1);
  });

  it('throws on an error status, with the response', async () => {
    const api = await stub(() => ({ status: 403, body: { message: 'Resource not accessible' } }));
    await expect(paginate(github(api.url), '/issues')).rejects.toThrow(
      /HTTP 403 .*Resource not accessible/,
    );
  });
});

/** A PR as GitHub's REST API lists it. */
const pull = (number: number, ref: string, base: string, labels = ['mfm-update'], repo = REPO) => ({
  number,
  head: { ref, repo: repo ? { full_name: repo } : null },
  base: { ref: base },
  labels: labels.map((name) => ({ name })),
});

describe('retries', () => {
  /** A stub that answers each request with the next status, then 200 for good. */
  const answering = (...statuses: number[]) =>
    stub(() => ({ status: statuses.shift() ?? 200, body: [{ n: 1 }] }));

  it.each([429, 500, 502, 503, 504])('retries a GET answered %i', async (status) => {
    const api = await answering(status, status);
    await expect(paginate(github(api.url), '/issues')).resolves.toEqual([{ n: 1 }]);
    expect(api.calls).toHaveLength(3);
  });

  it('gives up after three tries, with the last answer', async () => {
    const api = await answering(503, 503, 503);
    await expect(paginate(github(api.url), '/issues')).rejects.toThrow(/HTTP 503/);
    expect(api.calls).toHaveLength(3);
  });

  it.each([429, 502, 503, 504])('retries a write GitHub never served (%i)', async (status) => {
    const api = await answering(status);
    await request(github(api.url), 'POST', '/issues/1/comments', { body: 'x' });
    expect(api.calls.map((c) => c.method)).toEqual(['POST', 'POST']);
  });

  it('does not repeat a write answered 500, which may have been made already', async () => {
    const api = await answering(500);
    await expect(
      request(github(api.url), 'POST', '/issues/1/comments', { body: 'x' }),
    ).rejects.toThrow(/HTTP 500/);
    expect(api.calls).toHaveLength(1);
  });

  it('does not retry a client error', async () => {
    const api = await answering(404);
    await expect(paginate(github(api.url), '/issues')).rejects.toThrow(/HTTP 404/);
    expect(api.calls).toHaveLength(1);
  });
});

describe('listUpdatePrs', () => {
  it('keeps labelled mfm/ PRs from this repository, newest first, as the plan reads them', async () => {
    const api = await stub(() => ({
      body: [
        pull(80, 'mfm/v1.7', 'mfm/v1.6'),
        pull(79, 'mfm/v1.9', 'main', ['mfm-update'], 'someone/fork'),
        pull(77, 'mfm/v1.8', 'main', ['mfm-update'], ''),
        pull(76, 'mfm/v1.6', 'main', []),
        pull(59, 'dependabot/npm_and_yarn/x', 'main', ['mfm-update']),
        pull(78, 'mfm/v1.6', 'main'),
      ],
    }));
    await expect(listUpdatePrs(github(api.url))).resolves.toEqual([
      { number: 80, headRefName: 'mfm/v1.7', baseRefName: 'mfm/v1.6' },
      { number: 78, headRefName: 'mfm/v1.6', baseRefName: 'main' },
    ]);
    expect(api.calls[0]?.path).toBe(`/repos/${REPO}/pulls?state=open&per_page=100`);
  });
});

// ---- Copying data/ from origin ----------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'mfm-ops-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** git in `cwd`, never in a repository an inherited `GIT_DIR` names (a hook sets one). */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, env: gitEnv(), stdio: 'pipe' },
  ).toString();

/**
 * A GitHub-like `origin` with an update branch, and a checkout of `main` that doesn't have
 * the branch yet: shallow, as the workflow's is, unless `shallow` is false (a developer's
 * full clone).
 */
function originWithBranch(branch: string, files: Record<string, string>, shallow = true): string {
  const root = mkdtempSync(join(scratch, 'repo-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  mkdirSync(work);
  git(root, 'init', '--bare', origin);
  git(work, 'init');
  git(work, 'remote', 'add', 'origin', origin);
  mkdirSync(join(work, 'data'));
  writeFileSync(join(work, 'data', 'necrons.yaml'), 'name: Necrons\n');
  writeFileSync(join(work, 'README.md'), 'not data\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'main');
  git(work, 'push', 'origin', 'main');
  git(work, 'checkout', '-b', branch);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(work, 'data', path, '..'), { recursive: true });
    writeFileSync(join(work, 'data', path), text);
  }
  git(work, 'add', '.');
  git(work, 'commit', '-m', branch);
  git(work, 'push', 'origin', branch);

  const checkout = join(root, 'checkout');
  const url = `file://${origin.replaceAll('\\', '/')}`;
  git(root, 'clone', ...(shallow ? ['--depth=1'] : []), '--branch', 'main', url, checkout);
  return checkout;
}

describe('exportBranchData', () => {
  it('fetches a branch and copies its data/, files only, leaving the checkout alone', async () => {
    const files = {
      'necrons.yaml': 'name: Necrons\nversion: "1.6"\n',
      'meta.yaml': 'version: "1.6"\n',
    };
    const checkout = originWithBranch('mfm/v1.6', files);
    const dir = join(scratch, 'out-1');
    await exportBranchData('mfm/v1.6', dir, checkout);

    expect(readdirSync(dir).sort()).toEqual(['meta.yaml', 'necrons.yaml']);
    expect(readFileSync(join(dir, 'necrons.yaml'), 'utf8')).toBe(files['necrons.yaml']);
    expect(git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(checkout, 'status', '--porcelain')).toBe('');
    // One commit deep, as the workflow's checkout is.
    expect(git(checkout, 'rev-list', '--count', 'refs/remotes/origin/mfm/v1.6').trim()).toBe('1');
  });

  it('leaves a full clone full', async () => {
    const checkout = originWithBranch('mfm/v1.6', { 'a.yaml': 'a: 1\n' }, false);
    await exportBranchData('mfm/v1.6', join(scratch, 'out-full'), checkout);
    expect(readFileSync(join(scratch, 'out-full', 'a.yaml'), 'utf8')).toBe('a: 1\n');
    expect(git(checkout, 'rev-parse', '--is-shallow-repository').trim()).toBe('false');
    expect(existsSync(join(checkout, '.git', 'shallow'))).toBe(false);
    // The branch arrives with its history, main's commit included.
    expect(git(checkout, 'rev-list', '--count', 'refs/remotes/origin/mfm/v1.6').trim()).toBe('2');
  });

  it('copies files byte for byte, nested ones and multi-byte text included', async () => {
    const files = { 'sub/deep.yaml': 'a: “x”\n', 'plain.yaml': 'b: 1\n\n' };
    const checkout = originWithBranch('mfm/v1.7', files);
    const dir = join(scratch, 'out-2');
    await exportBranchData('mfm/v1.7', dir, checkout);
    expect(readFileSync(join(dir, 'sub', 'deep.yaml'), 'utf8')).toBe('a: “x”\n');
    expect(readFileSync(join(dir, 'plain.yaml'), 'utf8')).toBe('b: 1\n\n');
  });

  it('leaves the enclosing repository alone when run from a git hook', async () => {
    // A git hook (lefthook's pre-push runs this suite) exports GIT_DIR, GIT_WORK_TREE and
    // GIT_INDEX_FILE. Once, the `git init --bare` in `originWithBranch` inherited them and
    // set `core.bare = true` on the developer's own checkout. Stand one in for it here.
    const parent = join(scratch, 'parent');
    mkdirSync(parent);
    git(parent, 'init');
    writeFileSync(join(parent, 'file.txt'), 'parent\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'parent');
    const config = readFileSync(join(parent, '.git', 'config'), 'utf8');
    const refs = git(parent, 'for-each-ref');

    vi.stubEnv('GIT_DIR', join(parent, '.git'));
    vi.stubEnv('GIT_WORK_TREE', parent);
    vi.stubEnv('GIT_INDEX_FILE', join(parent, '.git', 'index'));
    try {
      const checkout = originWithBranch('mfm/v1.6', { 'a.yaml': 'a: 1\n' });
      await exportBranchData('mfm/v1.6', join(scratch, 'out-hook'), checkout);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(readFileSync(join(scratch, 'out-hook', 'a.yaml'), 'utf8')).toBe('a: 1\n');
    expect(readFileSync(join(parent, '.git', 'config'), 'utf8')).toBe(config);
    expect(git(parent, 'config', 'core.bare').trim()).toBe('false');
    expect(git(parent, 'for-each-ref')).toBe(refs);
    expect(git(parent, 'status', '--porcelain')).toBe('');
  });

  it('throws for a branch origin does not have', async () => {
    const checkout = originWithBranch('mfm/v1.6', { 'a.yaml': 'a: 1\n' });
    await expect(exportBranchData('mfm/v9.9', join(scratch, 'out-3'), checkout)).rejects.toThrow(
      /git fetch/,
    );
  });
});

describe('exportOpenPrs', () => {
  it("copies every open update PR's data/ under its branch name", async () => {
    const checkout = originWithBranch('mfm/v1.6', { 'meta.yaml': 'version: "1.6"\n' });
    const api = await stub(() => ({ body: [pull(78, 'mfm/v1.6', 'main')] }));
    const out = join(scratch, 'pr-data');
    const { prs, dirs } = await exportOpenPrs(github(api.url), out, checkout);
    expect(prs).toEqual([{ number: 78, headRefName: 'mfm/v1.6', baseRefName: 'main' }]);
    expect(dirs).toEqual([join(out, 'mfm/v1.6')]);
    expect(readFileSync(join(out, 'mfm', 'v1.6', 'meta.yaml'), 'utf8')).toBe('version: "1.6"\n');
  });
});

// ---- The failure issue -------------------------------------------------------------

describe('reportFailure', () => {
  it('opens an issue when none is open, with the run and the per-faction report', async () => {
    const api = await stub((call) =>
      call.method === 'GET' ? { body: [] } : { status: 201, body: { number: 90 } },
    );
    const details = '## 1 faction failed to parse\n\n### necrons\n\n```\nboom\n```\n';
    await expect(reportFailure(github(api.url), RUN, details, '2026-10-23')).resolves.toEqual({
      number: 90,
      created: true,
    });
    expect(api.calls[0]?.path).toBe(
      `/repos/${REPO}/issues?labels=scrape-failure&state=open&sort=created&direction=asc&per_page=1`,
    );
    expect(writes(api.calls)).toEqual([
      {
        call: `POST /repos/${REPO}/issues`,
        body: {
          title: 'Scrape failed (2026-10-23)',
          labels: ['scrape-failure'],
          body: `The scheduled MFM scrape failed — the source site markup may have drifted, or a faction stopped parsing.\n\n${failureReport(RUN, details)}`,
        },
      },
    ]);
  });

  it('comments on the open issue instead of opening another', async () => {
    const api = await stub((call) => (call.method === 'GET' ? { body: [{ number: 85 }] } : {}));
    await expect(reportFailure(github(api.url), RUN, '')).resolves.toEqual({
      number: 85,
      created: false,
    });
    expect(writes(api.calls)).toEqual([
      {
        call: `POST /repos/${REPO}/issues/85/comments`,
        body: { body: `The scheduled MFM scrape failed again.\n\n${failureReport(RUN, '')}` },
      },
    ]);
  });

  it('says where to look when no per-faction report was captured', () => {
    const report = failureReport(RUN, '  \n');
    expect(report).toContain(`**Run log:** ${RUN}`);
    expect(report).toContain('_No per-faction detail was captured');
    expect(report).toContain('`.agents/skills/diagnose-parse/SKILL.md`');
  });
});

describe('resolveFailure', () => {
  it('comments on and closes every open failure issue', async () => {
    const api = await stub((call) =>
      call.method === 'GET' ? { body: [{ number: 85 }, { number: 88 }] } : {},
    );
    await expect(resolveFailure(github(api.url), RUN)).resolves.toEqual([85, 88]);
    const comment = { body: `The scheduled scrape succeeded again: ${RUN}` };
    const close = { state: 'closed', state_reason: 'completed' };
    expect(writes(api.calls)).toEqual([
      { call: `POST /repos/${REPO}/issues/85/comments`, body: comment },
      { call: `PATCH /repos/${REPO}/issues/85`, body: close },
      { call: `POST /repos/${REPO}/issues/88/comments`, body: comment },
      { call: `PATCH /repos/${REPO}/issues/88`, body: close },
    ]);
  });

  it('does nothing when no failure issue is open', async () => {
    const api = await stub(() => ({ body: [] }));
    await expect(resolveFailure(github(api.url), RUN)).resolves.toEqual([]);
    expect(writes(api.calls)).toEqual([]);
  });
});

// ---- The Discord marker ------------------------------------------------------------

describe('the Discord marker', () => {
  it('is read from the last comment that carries one', () => {
    expect(
      recordedMessageId([
        'Announced on Discord: x <!-- discord-message-id: 111 -->',
        'LGTM',
        'Announced on Discord: y <!-- discord-message-id: 222 -->',
        '<!-- discord-message-id: not-a-number -->',
      ]),
    ).toBe('222');
    expect(recordedMessageId(['no marker here'])).toBeUndefined();
  });

  it('is written with the permalink, or without a link of any other shape', () => {
    expect(markerComment({ id: '999', url: 'https://discord.com/channels/1/2/999' })).toBe(
      'Announced on Discord: https://discord.com/channels/1/2/999 <!-- discord-message-id: 999 -->',
    );
    expect(markerComment({ id: '999', url: 'https://evil.invalid/x -->' })).toBe(
      'Announced on Discord: link unavailable <!-- discord-message-id: 999 -->',
    );
    expect(markerComment({ id: '999' })).toContain('link unavailable');
  });

  it('is never written for an id that is not a snowflake', () => {
    expect(() => markerComment({ id: '1 --> <img src=x>' })).toThrow(/unexpected message id/);
  });
});

const message: DiscordMessage = {
  embeds: [
    {
      title: 'MFM v1.6 update — 2026-10-14',
      url: 'https://example.invalid',
      description: 'test',
      color: 0,
      fields: [],
      footer: { text: 'test' },
      timestamp: '2026-10-14T00:00:00.000Z',
    },
  ],
  allowed_mentions: { parse: [] },
};

/** A PR comment as the REST API lists it, by the workflow's bot unless said otherwise. */
const comment = (body: string, login = 'github-actions[bot]') => ({ body, user: { login } });

describe('announceOnPr', () => {
  it('edits the message the PR records, and records nothing new', async () => {
    const api = await stub(() => ({
      body: [comment('Announced on Discord: x <!-- discord-message-id: 555 -->')],
    }));
    const discord = await stub(() => ({ body: { id: '555' } }));
    const hook = `${discord.url}/api/webhooks/1/token`;

    await expect(announceOnPr(github(api.url), 78, hook, message)).resolves.toBeUndefined();
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /repos/${REPO}/issues/78/comments?per_page=100`,
    ]);
    expect(discord.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PATCH /api/webhooks/1/token/messages/555',
    ]);
  });

  it('posts when the PR records no message, then records it', async () => {
    const api = await stub((call) => (call.method === 'GET' ? { body: [{ body: 'LGTM' }] } : {}));
    const discord = await stub((call) =>
      call.method === 'GET'
        ? { body: { guild_id: '7', channel_id: '8' } }
        : { body: { id: '999', channel_id: '8' } },
    );
    const hook = `${discord.url}/api/webhooks/1/token`;

    await expect(announceOnPr(github(api.url), 78, hook, message)).resolves.toEqual({
      id: '999',
      url: 'https://discord.com/channels/7/8/999',
    });
    expect(writes(api.calls)).toEqual([
      {
        call: `POST /repos/${REPO}/issues/78/comments`,
        body: {
          body: 'Announced on Discord: https://discord.com/channels/7/8/999 <!-- discord-message-id: 999 -->',
        },
      },
    ]);
  });

  it("ignores a marker anyone but the workflow's bot wrote, and posts anew", async () => {
    const api = await stub((call) =>
      call.method === 'GET'
        ? {
            body: [
              comment('Announced on Discord: x <!-- discord-message-id: 555 -->'),
              comment('<!-- discord-message-id: 666 -->', 'someone'),
            ],
          }
        : {},
    );
    const discord = await stub(() => ({ body: { id: '555' } }));
    const hook = `${discord.url}/api/webhooks/1/token`;

    // The bot's own marker wins, even with a later forged one after it.
    await announceOnPr(github(api.url), 78, hook, message);
    expect(discord.calls.map((c) => c.path)).toEqual(['/api/webhooks/1/token/messages/555']);

    // With only a forged marker there is nothing to edit: it posts and records its own.
    const forged = await stub((call) =>
      call.method === 'GET' ? { body: [comment('<!-- discord-message-id: 666 -->', 'x')] } : {},
    );
    const fresh = await stub((call) =>
      call.method === 'GET' ? { status: 403 } : { body: { id: '999' } },
    );
    await announceOnPr(github(forged.url), 78, `${fresh.url}/api/webhooks/1/token`, message);
    expect(fresh.calls.map((c) => c.method)).toEqual(['POST', 'GET']);
  });

  it('counts the markers of the author it is told to', async () => {
    const api = await stub(() => ({
      body: [comment('<!-- discord-message-id: 777 -->', 'mfm-updates[bot]')],
    }));
    const discord = await stub(() => ({ body: { id: '777' } }));
    const hook = `${discord.url}/api/webhooks/1/token`;
    await announceOnPr(github(api.url), 78, hook, message, { author: 'mfm-updates[bot]' });
    expect(discord.calls.map((c) => c.path)).toEqual(['/api/webhooks/1/token/messages/777']);
  });

  it('records nothing when Discord answers with something that is not an id', async () => {
    const api = await stub(() => ({ body: [] }));
    const discord = await stub((call) =>
      call.method === 'GET' ? { status: 403 } : { body: { id: '1 --> injected' } },
    );
    const hook = `${discord.url}/api/webhooks/1/token`;

    await expect(announceOnPr(github(api.url), 78, hook, message)).rejects.toThrow(
      /unexpected message id/,
    );
    expect(writes(api.calls)).toEqual([]);
  });
});

describe('stepOutputs', () => {
  it('writes one key=value line per output', () => {
    expect(stepOutputs({ branch: 'mfm/v1.6', below: '' })).toBe('branch=mfm/v1.6\nbelow=\n');
  });

  it('refuses a value that would add outputs of its own', () => {
    expect(() => stepOutputs({ title: 'MFM\nbase=evil' })).toThrow(/spans lines/);
  });
});
