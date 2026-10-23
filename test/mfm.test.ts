import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS } from '../src/bin/commands.js';
import { main } from '../src/bin/mfm.js';
import { changelogIndex } from '../src/changelog.js';

// The frozen v1.6 dataset, so the expectations below don't move with data updates.
const DATA = fileURLToPath(new URL('./golden/data-v1.6', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mfm-cli-'));
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

describe('mfm --help', () => {
  it('lists every command', async () => {
    const { code, stdout } = await mfm('--help');
    expect(code).toBe(0);
    for (const name of Object.keys(COMMANDS)) expect(stdout).toContain(`  ${name}  `);
  });

  it.each(Object.keys(COMMANDS))('mfm %s --help explains the command', async (name) => {
    const { code, stdout } = await mfm(name, '--help');
    expect(code).toBe(0);
    expect(stdout.startsWith(`usage: mfm ${name}`)).toBe(true);
    // Every option the command takes is in its help.
    const command = await COMMANDS[name]?.load();
    for (const option of Object.keys(command?.options ?? {}))
      expect(stdout).toContain(`--${option}`);
  });
});

describe('usage errors exit 2 and say why', () => {
  it.each([
    [[], /usage: mfm <command>/],
    [['scrap'], /Unknown command: scrap/],
    [['diff', DATA], /expected 2 arguments, got 1/],
    [['diff', DATA, DATA, '--title'], /Unknown option '--title'/],
    [['plan', 'prs.json', DATA, '--output'], /--output/],
    [['open-prs', '--json', 'x.json'], /--out is required/],
    [['announce', DATA, DATA, '--record'], /--record needs --send and --pr-number/],
    [['announce', DATA, DATA, '--pr-number', '78abc'], /Not a PR number: 78abc/],
    [['render'], /expected 1 argument, got 0/],
    [['render', '../necrons'], /Not a faction slug: \.\.\/necrons/],
    [['render', 'necrons', '--legends', '--panels'], /--legends and --panels render different/],
  ])('mfm %j', async (argv, message) => {
    const { code, stdout, stderr } = await mfm(...argv);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(message);
  });
});

describe('a module that used to be a command', () => {
  const TSX = pathToFileURL(
    fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
  );

  it.each([
    ['src/diff.ts', 'mfm diff'],
    ['src/stack.ts', 'mfm plan'],
    ['src/discord.ts', 'mfm announce'],
  ])('%s, run directly, fails and names %s', { timeout: 60_000 }, async (file, command) => {
    const script = fileURLToPath(new URL(`../${file}`, import.meta.url));
    const run = promisify(execFile)(process.execPath, ['--import', TSX.href, script, DATA, DATA]);
    // A caller that still runs the old entrypoint must not take silence for success.
    await expect(run).rejects.toMatchObject({ code: 1, stdout: '' });
    await run.catch((err: { stderr: string }) =>
      expect(err.stderr).toContain(`use \`${command}\``),
    );
  });
});

describe('the `--` pnpm passes through', () => {
  it('is dropped before the command', async () => {
    const { code, stdout } = await mfm('--', '--help');
    expect(code).toBe(0);
    expect(stdout).toMatch(/^usage: mfm <command>/);
  });

  it('is dropped right after it', async () => {
    const { code, stdout } = await mfm('diff', '--', DATA, DATA);
    expect(code).toBe(0);
    expect(stdout).toBe('No changes detected.\n');
  });
});

describe('step outputs', () => {
  it('mfm plan appends them to --output, and prints nothing', async () => {
    const prs = join(scratch, 'prs.json');
    writeFileSync(
      prs,
      JSON.stringify([{ number: 78, headRefName: 'mfm/v1.6', baseRefName: 'main' }]),
    );
    const output = join(scratch, 'plan-output');
    writeFileSync(output, 'earlier=1\n');
    const { code, stdout } = await mfm('plan', prs, DATA, '--output', output);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(readFileSync(output, 'utf8')).toBe('earlier=1\nbranch=mfm/v1.6\nbase=main\nbelow=\n');
  });

  it('mfm diff writes the body to --body-file and the title to --output', async () => {
    const body = join(scratch, 'body.md');
    const output = join(scratch, 'diff-output');
    const { stdout } = await mfm('diff', DATA, DATA, '--body-file', body, '--output', output);
    expect(stdout).toBe('No changes detected.\n');
    expect(readFileSync(body, 'utf8')).toBe(stdout);
    expect(readFileSync(output, 'utf8')).toMatch(/^title=MFM v1\.6 update — \d{4}-\d\d-\d\d\n$/);
  });
});

describe('mfm check-data', () => {
  /** A repository holding the frozen dataset and a matching index, with `edit` applied. */
  function repository(edit: (root: string) => void = () => {}): string {
    const root = mkdtempSync(join(scratch, 'repo-'));
    cpSync(DATA, join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'changelog'));
    writeFileSync(join(root, 'DATA-CHANGELOG.md'), changelogIndex([]));
    edit(root);
    return root;
  }

  it('passes canonical files, and says so on stdout', async () => {
    const { code, stdout, stderr } = await mfm('check-data', '--root', repository());
    expect(code).toBe(0);
    expect(stdout).toBe(
      'check-data: 30 faction files, meta.yaml and DATA-CHANGELOG.md are canonical.\n',
    );
    expect(stderr).toBe('');
  });

  it('fails a hand-edited file, naming it', async () => {
    const root = repository((r) => {
      const file = join(r, 'data', 'necrons.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace('slug: necrons', 'slug:  necrons'));
    });
    const { code, stdout, stderr } = await mfm('check-data', '--root', root);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^✗ data\/necrons\.yaml is not canonical: line 2 /);
    expect(stderr).toMatch(/\n\ncheck-data: 1 problem\. These files are generated by the scraper/);
  });
});

describe('mfm announce --send', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips quietly when no webhook is configured', async () => {
    vi.stubEnv('DISCORD_WEBHOOK_URL', '');
    const dir = mkdtempSync(join(scratch, 'announce-'));
    for (const name of ['meta.yaml', 'necrons.yaml'])
      writeFileSync(join(dir, name), readFileSync(join(DATA, name), 'utf8'));
    const { code, stdout, stderr } = await mfm('announce', dir, DATA, '--send');
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('DISCORD_WEBHOOK_URL is not set — skipping the announcement.\n');
  });

  it('refuses a webhook that is not Discord’s', async () => {
    vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.com.example.invalid/api/webhooks/1/x');
    const dir = mkdtempSync(join(scratch, 'announce-'));
    writeFileSync(join(dir, 'meta.yaml'), readFileSync(join(DATA, 'meta.yaml'), 'utf8'));
    await expect(mfm('announce', dir, DATA, '--send')).rejects.toThrow(/not a Discord webhook/);
  });
});

describe('the failure issue, from the environment Actions provides', () => {
  let server: Server | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise((done) => server?.close(done));
    server = undefined;
  });

  /** A GitHub API with one open failure issue, #85; the requests it got. */
  async function github() {
    const calls: { method: string; path: string; body: string }[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        calls.push({ method: req.method ?? '', path: req.url ?? '', body });
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(req.method === 'GET' ? '[{"number":85}]' : '{}');
      });
    });
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    vi.stubEnv('GITHUB_API_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
    vi.stubEnv('GITHUB_REPOSITORY', 'BSData/wh40k-11e-mfm');
    vi.stubEnv('GITHUB_RUN_ID', '42');
    vi.stubEnv('GH_TOKEN', 't0ken');
    return calls;
  }

  it('mfm report-failure comments the report on the open issue', async () => {
    const calls = await github();
    const details = join(scratch, 'failures.md');
    writeFileSync(details, '## 1 faction failed to parse\n');
    const { code, stderr } = await mfm('report-failure', '--details', details);
    expect(code).toBe(0);
    expect(stderr).toBe('Commented on issue #85.\n');
    const comment = calls.find((c) => c.method === 'POST');
    expect(comment?.path).toBe('/repos/BSData/wh40k-11e-mfm/issues/85/comments');
    const body = JSON.parse(comment?.body ?? '{}').body as string;
    expect(body).toContain('**Run log:** https://github.com/BSData/wh40k-11e-mfm/actions/runs/42');
    expect(body).toContain('## 1 faction failed to parse');
  });

  it('mfm report-failure without a report file says none was captured', async () => {
    const calls = await github();
    await mfm('report-failure', '--details', join(scratch, 'missing.md'));
    expect(calls.find((c) => c.method === 'POST')?.body).toContain('No per-faction detail');
  });

  it('mfm resolve-failure closes it', async () => {
    const calls = await github();
    const { code, stderr } = await mfm('resolve-failure');
    expect(code).toBe(0);
    expect(stderr).toBe('Closed #85.\n');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'PATCH']);
  });
});
