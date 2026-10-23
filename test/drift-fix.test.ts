import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/bin/mfm.js';
import { failuresReport, readFailuresReport } from '../src/diff.js';
import { factionUrl, fetchText, isFetchFailure, LEGENDS_COOKIE } from '../src/fetch.js';
import { downloadFixtures, FIXTURES, fixturesForFailures } from '../src/fixtures.js';
import { driftFixGate, type GateInput, runMarker } from '../src/ops/drift-fix.js';
import type { GitHub } from '../src/ops/github.js';

/**
 * The drift fixer's plain-Actions half: what the failed scrape hands the agent
 * (`mfm refresh-fixtures --failed`), and the gate that lets an agent run start
 * (`mfm drift-fix-gate`). The patch check is in agent-patch.test.ts.
 */

const scratch = mkdtempSync(join(tmpdir(), 'drift-fix-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Run `mfm` in-process, collecting what it prints. */
async function mfm(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('the failures report, read back', () => {
  it('gives back what failuresReport() wrote', () => {
    const failures = [
      {
        slug: 'necrons',
        error: 'Unconsumed content on "necrons": page-level: "Terms of Website Use"',
      },
      {
        slug: 'rules panels',
        error: 'rules panel "Muster Armies": no collapsible\nwith that trigger label',
      },
      {
        slug: 'orks',
        error: 'Failed to fetch https://mfm.warhammer-community.com/en/orks after 4 attempts',
      },
    ];
    expect(readFailuresReport(failuresReport(failures))).toEqual(
      [...failures].sort((a, b) => a.slug.localeCompare(b.slug)),
    );
    expect(readFailuresReport('')).toEqual([]);
  });
});

describe('isFetchFailure — an outage, not drift', () => {
  it("knows the errors fetchText gives up with, and the scrape's for a page that never came", async () => {
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/gone' ? 404 : 503).end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ['/gone', '/down']) {
        const err = await fetchText(`${url}${path}`, { retries: 0 }).catch((e: Error) => e);
        expect(isFetchFailure((err as Error).message)).toBe(true);
      }
    } finally {
      await new Promise((done) => server.close(done));
    }
    expect(isFetchFailure('Failed to fetch the page they are read from ("necrons")')).toBe(true);
    expect(isFetchFailure('Unconsumed content on "necrons": page-level: "Failed to fetch"')).toBe(
      false,
    );
  });
});

describe('fixturesForFailures — the pages that show why a scrape failed', () => {
  const report = (...failures: { slug: string; error: string }[]) =>
    fixturesForFailures(failuresReport(failures)).map((fx) => fx.name);
  const drift = (slug: string) => ({
    slug,
    error: `Unconsumed content on "${slug}": page-level: "X"`,
  });

  it("picks a failed faction's own fixtures, as they are fetched for the tests", () => {
    const names = report(drift('necrons'));
    expect(names).toEqual(
      FIXTURES.filter((fx) => fx.url === factionUrl('necrons')).map((fx) => fx.name),
    );
    expect(names).toContain('necrons-legends-cookie.html');
    // No browser renders: the drift fixer's access to the site is plain HTTP.
    expect(names).not.toContain('necrons-panels.html');
  });

  it('saves the page as the scrape fetches it for a faction no fixture covers', () => {
    expect(fixturesForFailures(failuresReport([drift('orks')]))).toEqual([
      { name: 'orks-legends-cookie.html', url: factionUrl('orks'), cookie: LEGENDS_COOKIE },
    ]);
  });

  it("picks the rules panels' page for their failure, once however many need it", () => {
    expect(report({ slug: 'rules panels', error: 'rules panel "Notes": no collapsible' })).toEqual([
      'necrons-panels-rsc.html',
    ]);
    const both = report(drift('necrons'), { slug: 'rules panels', error: 'x' });
    expect(both.filter((n) => n === 'necrons-panels-rsc.html')).toHaveLength(1);
  });

  it('picks nothing for a page that failed to load, or for no report', () => {
    const down = (slug: string) => ({
      slug,
      error: `Failed to fetch ${factionUrl(slug)} after 4 attempts: x`,
    });
    expect(report(down('necrons'), down('orks'))).toEqual([]);
    expect(
      report({
        slug: 'rules panels',
        error: 'Failed to fetch the page they are read from ("necrons")',
      }),
    ).toEqual([]);
    expect(report()).toEqual([]);
  });

  it('refuses a heading that is not a slug: the slugs come from the site', () => {
    expect(() => fixturesForFailures('### ../../etc\n\n```\nx\n```')).toThrow(/Not a faction slug/);
  });
});

describe('downloadFixtures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves every page, or none when one fails', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: { cookie?: string } }) => {
      fetched.push(`${url} ${init.headers.cookie ?? ''}`.trim());
      if (url.endsWith('/broken')) return new Response('', { status: 404 });
      return new Response(`<html>${url}</html>`);
    });
    const pages = [
      { name: 'a.html', url: 'https://example.test/a', cookie: LEGENDS_COOKIE },
      { name: 'b.html', url: 'https://example.test/b' },
    ];
    const dir = join(scratch, 'ok');
    expect(await downloadFixtures(pages, dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['a.html', 'b.html']);
    expect(readFileSync(join(dir, 'a.html'), 'utf8')).toBe('<html>https://example.test/a</html>');
    expect(fetched[0]).toBe(`https://example.test/a ${LEGENDS_COOKIE}`);

    const partial = join(scratch, 'partial');
    await expect(
      downloadFixtures([...pages, { name: 'c.html', url: 'https://example.test/broken' }], partial),
    ).rejects.toThrow(/HTTP 404/);
    expect(() => readdirSync(partial)).toThrow();
  }, 10_000);
});

describe('mfm refresh-fixtures --failed', () => {
  it('downloads nothing for a missing report, or for an outage', async () => {
    const outage = join(scratch, 'outage.md');
    writeFileSync(
      outage,
      failuresReport([
        { slug: 'necrons', error: `Failed to fetch ${factionUrl('necrons')} after 4 attempts` },
      ]),
    );
    const out = join(scratch, 'none');
    for (const report of [join(scratch, 'missing.md'), outage]) {
      const { code, stderr } = await mfm('refresh-fixtures', '--failed', report, '--out', out);
      expect(code).toBe(0);
      expect(stderr).toMatch(/Nothing to refresh/);
    }
    expect(existsSync(out)).toBe(false);
  });
});

// --- the gate -------------------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  servers.length = 0;
});

const REPO = 'BSData/wh40k-11e-mfm';
const RUN_ID = '39663781655';

interface World {
  run?: Record<string, unknown>;
  artifacts?: { name: string; expired: boolean }[];
  pulls?: { number: number; labels: { name: string }[] }[];
  issues?: { number: number }[];
  comments?: { body: string; user: { login: string } }[];
}

/** GitHub as the gate sees it: one failed scrape run with its drift, and issue #96 open. */
async function github(world: World = {}) {
  const run = {
    path: '.github/workflows/scrape.yml',
    head_branch: 'main',
    conclusion: 'failure',
    head_repository: { full_name: REPO },
    ...world.run,
  };
  const replies: Record<string, unknown> = {
    [`/repos/${REPO}/actions/runs/${RUN_ID}`]: run,
    [`/repos/${REPO}/actions/runs/${RUN_ID}/artifacts?per_page=100`]: {
      artifacts: world.artifacts ?? [
        { name: 'failure-report', expired: false },
        { name: 'drift', expired: false },
      ],
    },
    [`/repos/${REPO}/pulls?state=open&per_page=100`]: world.pulls ?? [
      { number: 55, labels: [{ name: 'mfm-update' }] },
    ],
    [`/repos/${REPO}/issues?labels=scrape-failure&state=open&sort=created&direction=asc&per_page=1`]:
      world.issues ?? [{ number: 96 }],
    [`/repos/${REPO}/issues/96/comments?per_page=100`]: world.comments ?? [],
  };
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      calls.push({ method: req.method ?? '', path, body });
      const reply = req.method === 'GET' ? replies[path] : {};
      res
        .writeHead(reply === undefined ? 404 : 200, { 'content-type': 'application/json' })
        .end(JSON.stringify(reply ?? { message: 'Not Found' }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const gh: GitHub = {
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server: 'https://github.com',
    repo: REPO,
    token: 't0ken',
    retryDelayMs: 0,
  };
  const comments = () =>
    calls
      .filter((c) => c.method === 'POST')
      .map((c) => ({ path: c.path, body: (JSON.parse(c.body) as { body: string }).body }));
  return { gh, calls, comments };
}

const input = (over: Partial<GateInput> = {}): GateInput => ({
  runId: RUN_ID,
  branch: 'main',
  manual: false,
  thisRunUrl: `https://github.com/${REPO}/actions/runs/7`,
  ...over,
});

describe('driftFixGate', () => {
  it('lets a failed scrape with drift through, and records the run on the failure issue first', async () => {
    const { gh, comments } = await github();
    expect(await driftFixGate(gh, input())).toEqual({
      run: true,
      reason: expect.stringContaining('failed on parsing'),
      issue: 96,
      artifact: 'drift',
    });
    const [comment] = comments();
    expect(comment?.path).toBe(`/repos/${REPO}/issues/96/comments`);
    expect(comment?.body.startsWith(runMarker(RUN_ID))).toBe(true);
    expect(comment?.body).toContain(`https://github.com/${REPO}/actions/runs/7`);
    expect(comment?.body).toContain(`gh workflow run drift-fix.yml -f run-id=${RUN_ID}`);
  });

  it('runs once per outage: an earlier run recorded on the issue stops the next', async () => {
    const recorded = [
      {
        body: `${runMarker('111')}\nThe drift-fix agent is drafting…`,
        user: { login: 'github-actions[bot]' },
      },
    ];
    const { gh, comments } = await github({ comments: recorded });
    const gate = await driftFixGate(gh, input());
    expect(gate).toMatchObject({
      run: false,
      reason: expect.stringMatching(/\(111\) already ran for #96/),
    });
    expect(comments()).toEqual([]);
  });

  it("counts only the workflow's own markers, at the start of its comments", async () => {
    const { gh } = await github({
      comments: [
        { body: runMarker('111'), user: { login: 'someone' } },
        {
          body: `The scheduled MFM scrape failed again.\n\n\`\`\`\n${runMarker('112')}\n\`\`\``,
          user: { login: 'github-actions[bot]' },
        },
      ],
    });
    expect((await driftFixGate(gh, input())).run).toBe(true);
  });

  it('lets a manual replay run again for the same outage, and records it', async () => {
    const recorded = [{ body: runMarker('111'), user: { login: 'github-actions[bot]' } }];
    const { gh, comments } = await github({ comments: recorded });
    expect(await driftFixGate(gh, input({ manual: true }))).toMatchObject({ run: true, issue: 96 });
    expect(comments()).toHaveLength(1);
  });

  it('never runs while an agent-fix PR is open', async () => {
    const pulls = [{ number: 97, labels: [{ name: 'agent-fix' }] }];
    const { gh, comments } = await github({ pulls });
    for (const manual of [false, true]) {
      expect(await driftFixGate(gh, input({ manual }))).toMatchObject({
        run: false,
        reason: 'PR #97, labelled agent-fix, is still open',
      });
    }
    expect(comments()).toEqual([]);
  });

  it.each([
    ['only the failure report', [{ name: 'failure-report', expired: false }]],
    ['an expired drift artifact', [{ name: 'drift', expired: true }]],
    ['a dry run’s drift', [{ name: 'drift-dry-run', expired: false }]],
  ])('skips a failed scrape with %s: an outage, not drift', async (_, artifacts) => {
    const { gh, comments } = await github({ artifacts });
    expect(await driftFixGate(gh, input())).toMatchObject({
      run: false,
      reason: expect.stringMatching(/has no drift artifact/),
    });
    expect(comments()).toEqual([]);
  });

  it("takes a dry run's drift on a manual replay, with or without an open issue", async () => {
    const { gh, comments } = await github({
      artifacts: [{ name: 'drift-dry-run', expired: false }],
      issues: [],
    });
    expect(await driftFixGate(gh, input({ manual: true }))).toEqual({
      run: true,
      reason: expect.any(String),
      artifact: 'drift-dry-run',
    });
    expect(comments()).toEqual([]);
  });

  it('needs an open failure issue to record a run on, unless it is a replay', async () => {
    const { gh } = await github({ issues: [] });
    expect(await driftFixGate(gh, input())).toMatchObject({
      run: false,
      reason: expect.stringMatching(/No open scrape-failure issue/),
    });
  });

  it.each([
    [
      'another workflow',
      { path: '.github/workflows/ci.yml' },
      /not a \.github\/workflows\/scrape\.yml run/,
    ],
    ['another branch', { head_branch: 'feature' }, /ran on feature, not on main/],
    ['a fork', { head_repository: { full_name: 'someone/wh40k-11e-mfm' } }, /another repository/],
    ['a run that passed', { conclusion: 'success' }, /didn't fail: success/],
  ])('skips %s', async (_, run, why) => {
    const { gh, comments } = await github({ run });
    expect(await driftFixGate(gh, input())).toMatchObject({
      run: false,
      reason: expect.stringMatching(why),
    });
    expect(comments()).toEqual([]);
  });

  it('takes a run file named with its ref', async () => {
    const { gh } = await github({ run: { path: '.github/workflows/scrape.yml@refs/heads/main' } });
    expect((await driftFixGate(gh, input())).run).toBe(true);
  });

  it('checks the run id before asking GitHub anything', async () => {
    const { gh, calls } = await github();
    expect(await driftFixGate(gh, input({ runId: '1/../../pulls' }))).toMatchObject({ run: false });
    expect(calls).toEqual([]);
  });
});

describe('mfm drift-fix-gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes its decision as step outputs, from the environment Actions provides', async () => {
    const { gh, comments } = await github();
    vi.stubEnv('GITHUB_API_URL', gh.api);
    vi.stubEnv('GITHUB_REPOSITORY', REPO);
    vi.stubEnv('GITHUB_REF_NAME', 'main');
    vi.stubEnv('GITHUB_RUN_ID', '7');
    vi.stubEnv('GH_TOKEN', 't0ken');
    const output = join(scratch, 'gate-output');
    const { code, stderr } = await mfm('drift-fix-gate', '--run-id', RUN_ID, '--output', output);
    expect(code).toBe(0);
    expect(stderr).toMatch(/^Running: /);
    expect(readFileSync(output, 'utf8')).toBe('run=true\nissue=96\nartifact=drift\n');
    expect(comments()[0]?.body).toContain(`https://github.invalid/${REPO}/actions/runs/7`);
  });
});
