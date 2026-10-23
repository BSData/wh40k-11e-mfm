import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/bin/mfm.js';

// In this file every third-party library and the scraper itself fail to load. The commands
// that hold GH_TOKEN, and so report a failed scrape, must still run: `mfm` imports a
// command's module only when it runs, and theirs import none of these.
vi.mock('playwright', () => {
  throw new Error('broken: playwright');
});
vi.mock('cheerio', () => {
  throw new Error('broken: cheerio');
});
vi.mock('node-html-markdown', () => {
  throw new Error('broken: node-html-markdown');
});
vi.mock('yaml', () => {
  throw new Error('broken: yaml');
});
vi.mock('zod', () => {
  throw new Error('broken: zod');
});
vi.mock('../src/scrape.js', () => {
  throw new Error('broken: the scraper');
});

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

describe('a command loads only what it uses', () => {
  // Whatever an earlier import (a setup file) already loaded is loaded again, under the
  // mocks above, when a command's module imports it.
  beforeEach(() => {
    vi.resetModules();
  });

  let server: Server | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise((done) => server?.close(done));
    server = undefined;
  });

  /** A GitHub API with one open failure issue, #85, as Actions' environment names it. */
  async function github() {
    const calls: string[] = [];
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        calls.push(`${req.method} ${req.url}`);
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(req.method === 'GET' ? '[{"number":85}]' : '{}');
      });
    });
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    vi.stubEnv('GITHUB_API_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    vi.stubEnv('GITHUB_REPOSITORY', 'BSData/wh40k-11e-mfm');
    vi.stubEnv('GITHUB_RUN_ID', '42');
    vi.stubEnv('GH_TOKEN', 't0ken');
    return calls;
  }

  it('the libraries are broken here', async () => {
    await expect(mfm('scrape', '--help')).rejects.toThrow();
    await expect(mfm('diff', '--help')).rejects.toThrow();
  });

  it('mfm --help still lists every command', async () => {
    expect((await mfm('--help')).stdout).toContain('report-failure');
  });

  it('mfm report-failure still reports', async () => {
    const calls = await github();
    const { code, stderr } = await mfm('report-failure', '--details', 'missing.md');
    expect(code).toBe(0);
    expect(stderr).toBe('Commented on issue #85.\n');
    expect(calls).toContain('POST /repos/BSData/wh40k-11e-mfm/issues/85/comments');
  });

  it('mfm resolve-failure still closes', async () => {
    const calls = await github();
    expect((await mfm('resolve-failure')).code).toBe(0);
    expect(calls).toContain('PATCH /repos/BSData/wh40k-11e-mfm/issues/85');
  });

  it.each(['open-prs', 'branch-data'])('mfm %s still loads', async (name) => {
    expect((await mfm(name, '--help')).code).toBe(0);
  });
});
