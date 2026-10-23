import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type Api, entriesSince, main, sweepCaches } from '../src/ops/cache-sweep.js';

/**
 * The drift fixer's `caches` job (src/ops/cache-sweep.ts): every Actions cache entry
 * created while the agent's job ran is deleted, however many there are.
 */

const REPO = 'BSData/wh40k-11e-mfm';
const SINCE = new Date('2026-10-23T04:00:00Z');

interface Entry {
  id: number;
  key: string;
  created_at: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  servers.length = 0;
});

/**
 * GitHub's cache API over `entries`, newest first by creation, a page at a time. `onDelete`
 * answers a delete (204 by default) and may add entries, as a writer still at work would.
 */
async function github(entries: Entry[], onDelete: (id: number) => number = () => 204) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://stub');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.method === 'GET' && url.pathname === `/repos/${REPO}/actions/caches`) {
      expect(url.searchParams.get('sort')).toBe('created_at');
      expect(url.searchParams.get('direction')).toBe('desc');
      const per = Number(url.searchParams.get('per_page'));
      const page = Number(url.searchParams.get('page'));
      const sorted = [...entries].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const body = {
        total_count: sorted.length,
        actions_caches: sorted.slice((page - 1) * per, page * per),
      };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    const id = Number(url.pathname.match(/\/actions\/caches\/(\d+)$/)?.[1]);
    if (req.method === 'DELETE' && id) {
      const index = entries.findIndex((e) => e.id === id);
      const status = index < 0 ? 404 : onDelete(id);
      // A 404 means someone else deleted it: it is gone either way.
      if ((status === 204 || status === 404) && index >= 0) entries.splice(index, 1);
      res.writeHead(status).end(status === 204 ? '' : '{"message":"no"}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const api: Api = {
    root: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    repo: REPO,
    token: 't0ken',
    retryDelayMs: 0,
  };
  return { api, requests, entries };
}

/** `n` entries created one second apart, from `start` on. */
const entriesFrom = (start: string, n: number, firstId: number): Entry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: firstId + i,
    key: `key-${firstId + i}`,
    created_at: new Date(Date.parse(start) + i * 1000).toISOString(),
  }));

describe('sweepCaches', () => {
  it('deletes every entry created since the cutoff, past a page of later ones, and leaves the older', async () => {
    const before = entriesFrom('2026-10-23T03:00:00Z', 30, 1);
    const since = entriesFrom('2026-10-23T04:00:00Z', 250, 1000);
    const { api, requests, entries } = await github([...before, ...since]);
    expect((await entriesSince(api, SINCE)).length).toBe(250);
    const result = await sweepCaches(api, SINCE);
    expect(result).toEqual({ deleted: 250, left: [] });
    expect(entries.map((e) => e.id).sort((a, b) => a - b)).toEqual(before.map((e) => e.id));
    // It stopped at the first page with an older entry, rather than listing them all.
    expect(requests.filter((r) => r.startsWith('GET')).every((r) => !r.includes('page=5'))).toBe(
      true,
    );
  });

  it('takes an entry deleted already as gone', async () => {
    const { api } = await github(entriesFrom('2026-10-23T04:00:01Z', 2, 1), (id) =>
      id === 1 ? 404 : 204,
    );
    expect(await sweepCaches(api, SINCE)).toEqual({ deleted: 2, left: [] });
  });

  it('goes round again for entries written while it deleted', async () => {
    let added = false;
    const fixture = await github(entriesFrom('2026-10-23T04:00:01Z', 3, 1), () => {
      if (!added) {
        added = true;
        fixture.entries.push(...entriesFrom('2026-10-23T04:30:00Z', 2, 50));
      }
      return 204;
    });
    expect(await sweepCaches(fixture.api, SINCE)).toEqual({ deleted: 5, left: [] });
  });

  it('reports what it could not delete', async () => {
    const { api } = await github(entriesFrom('2026-10-23T04:00:01Z', 2, 1), (id) =>
      id === 2 ? 403 : 204,
    );
    const result = await sweepCaches(api, SINCE);
    expect(result.deleted).toBe(1);
    expect(result.left.map((e) => e.id)).toEqual([2]);
  });

  it('gives up on entries that keep coming, and reports them', async () => {
    let next = 100;
    const fixture = await github(entriesFrom('2026-10-23T04:00:01Z', 1, 1), () => {
      fixture.entries.push(...entriesFrom('2026-10-23T05:00:00Z', 1, next++));
      return 204;
    });
    const result = await sweepCaches(fixture.api, SINCE);
    expect(result.left.length).toBeGreaterThan(0);
  });
});

describe('the command line', () => {
  it('exits 0 when nothing is left, 1 when something is, 2 on a bad command line', async () => {
    const clean = await github(entriesFrom('2026-10-23T04:00:01Z', 2, 1));
    const env = { GITHUB_API_URL: clean.api.root, GITHUB_REPOSITORY: REPO, GH_TOKEN: 't0ken' };
    expect(await main(['--since', '2026-10-23T04:00:00Z'], env)).toBe(0);
    const stuck = await github(entriesFrom('2026-10-23T04:00:01Z', 1, 1), () => 403);
    expect(
      await main(['--since', '2026-10-23T04:00:00Z'], { ...env, GITHUB_API_URL: stuck.api.root }),
    ).toBe(1);
    expect(await main(['--since', 'yesterday'], env)).toBe(2);
    expect(await main(['--since', '2026-10-23T04:00:00Z'], { ...env, GH_TOKEN: '' })).toBe(2);
  });
});

describe('it runs where actions: write is: plain Node, no dependencies', () => {
  const file = fileURLToPath(new URL('../src/ops/cache-sweep.ts', import.meta.url));
  const source = readFileSync(file, 'utf8');

  it("imports Node's own modules and nothing else", () => {
    const imports = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map(
      (m) => m[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier).toMatch(/^node:/);
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });

  it('runs under node --experimental-strip-types, outside the test runner', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', file, '--since', 'x'],
      {
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: cache-sweep\.ts --since/);
  });
});
