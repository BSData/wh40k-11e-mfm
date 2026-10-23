import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
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
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/bin/mfm.js';
import { ENTRIES_MARKER } from '../src/changelog.js';
import { loadFactionDir } from '../src/diff.js';
import { metaFromYaml } from '../src/emit.js';
import { Dataset } from '../src/model.js';
import { gitEnv } from '../src/ops/git-env.js';
import { historicalVerdict, verdict } from '../src/ops/release.js';
import {
  datasetJson,
  dataZip,
  NOTES_LIMIT,
  newestEntry,
  releaseNotes,
  releaseTag,
} from '../src/release.js';
import { frozenRepository, V16_CHANGELOG } from './frozen-repo.js';

/** The release of the data on `main` (see "Releases" in specs/data-model.md). */

const scratch = mkdtempSync(join(tmpdir(), 'mfm-release-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GOLDEN = fileURLToPath(new URL('./golden', import.meta.url));
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const FILE_URL = `https://github.com/BSData/wh40k-11e-mfm/blob/${SHA}/changelog/v1.6.md`;

describe('newestEntry', () => {
  it('is the first entry under the marker, up to the next one', () => {
    const entry = newestEntry(V16_CHANGELOG);
    expect(entry.window).toBe('2026-10-20 → 2026-10-22');
    expect(entry.label).toBe('MFM v1.6');
    expect(newestEntry(`${ENTRIES_MARKER}\n\n## [2026-10-23] — Name casing\n`).label).toBe(
      'Name casing',
    );
    expect(entry.text).toMatch(/^## \[2026-10-20 → 2026-10-22\] — MFM v1\.6\n\n\*\*1 faction/);
    expect(entry.text).toMatch(/moved to Legends$/);
    expect(entry.text).not.toContain('2026-10-14');
    expect(entry.nth).toBe(1);
  });

  it('counts the entries before it that end on the same day', () => {
    const file = (...headings: string[]) =>
      `${ENTRIES_MARKER}\n\n${headings.map((h) => `## [${h}] — x\n\ny\n`).join('\n')}`;
    expect(newestEntry(file('2026-10-23', '2026-10-23', '2026-10-22')).nth).toBe(2);
    expect(newestEntry(file('2026-10-21 → 2026-10-23', '2026-10-23', '2026-10-23')).nth).toBe(3);
    expect(newestEntry(file('2026-10-24', '2026-10-23')).nth).toBe(1);
  });

  it('fails a file with no entry', () => {
    expect(() => newestEntry(`# MFM v1.7\n\n${ENTRIES_MARKER}\n`)).toThrow('no entry');
    expect(() => newestEntry('## [2026-10-14] — MFM v1.6\n')).toThrow('no entry');
  });
});

describe('releaseTag', () => {
  it('is the version and the last day of the window', () => {
    expect(releaseTag('1.6', '2026-10-22')).toBe('mfm-v1.6+2026-10-22');
    expect(releaseTag('1.5', '2026-10-02 → 2026-10-05')).toBe('mfm-v1.5+2026-10-05');
  });

  it('numbers a later entry ending the same day', () => {
    expect(releaseTag('1.6', '2026-10-23', 1)).toBe('mfm-v1.6+2026-10-23');
    expect(releaseTag('1.6', '2026-10-23', 2)).toBe('mfm-v1.6+2026-10-23.2');
  });

  it.each([
    ['1.6 beta', '2026-10-22', 1],
    ['1.6', 'Name casing', 1],
    ['1.6', '2026-10-22 → soon', 1],
    ['1.6', '2026-10-22', 0],
  ])('refuses version %j dated %j, entry %j', (version, window, nth) => {
    expect(() => releaseTag(version, window, nth)).toThrow();
  });
});

describe('releaseNotes', () => {
  const entry = newestEntry(V16_CHANGELOG).text;

  it('is the entry, with its relative links pointing at the file at the commit', () => {
    const notes = releaseNotes(entry, FILE_URL);
    expect(notes.startsWith('## [2026-10-20 → 2026-10-22] — MFM v1.6\n')).toBe(true);
    expect(notes).toContain(
      `see [Names](https://github.com/BSData/wh40k-11e-mfm/blob/${SHA}/specs/data-model.md#names)`,
    );
  });

  it('leaves absolute links and anchors alone', () => {
    const text = '## [2026-10-22] — x\n\n[a](https://example.com/a) [b](#b) [c](mailto:c@d.e)';
    expect(releaseNotes(text, FILE_URL)).toContain(
      '[a](https://example.com/a) [b](#b) [c](mailto:c@d.e)',
    );
  });

  it('ends with the schema version and the attribution', () => {
    const notes = releaseNotes(entry, FILE_URL);
    expect(notes).toMatch(/\n---\n\nData at `schemaVersion` 2\. /);
    expect(notes).toContain('(© Games Workshop)');
    expect(notes.endsWith('\n')).toBe(true);
  });

  it('links the file instead of an entry over GitHub’s limit', () => {
    const long = `## [2026-10-22] — MFM v1.6\n\n${'- a line\n'.repeat(NOTES_LIMIT / 8)}`;
    const notes = releaseNotes(long, FILE_URL);
    expect(notes.length).toBeLessThan(NOTES_LIMIT);
    expect(notes).toContain(`read it in [v1.6.md](${FILE_URL})`);
  });
});

describe('the assets', () => {
  const root = frozenRepository(scratch);
  const meta = metaFromYaml(readFileSync(join(root, 'data', 'meta.yaml'), 'utf8'));
  const factions = loadFactionDir(join(root, 'data'));

  it('all.json holds meta.yaml and every faction, schemaVersion first', () => {
    const json = datasetJson(meta, factions);
    expect(json).toMatch(/^\{"schemaVersion":2,"meta":\{"schemaVersion":2,"version":"1\.6",/);
    const dataset = Dataset.parse(JSON.parse(json));
    expect(dataset.factions.map((f) => f.slug)).toEqual(meta.factions);
  });

  it('data.zip holds data/, the same bytes in every time zone', () => {
    const files = readdirSync(join(root, 'data')).map((name) => ({
      name,
      data: readFileSync(join(root, 'data', name)),
    }));
    const zipIn = (tz: string) => {
      vi.stubEnv('TZ', tz);
      try {
        return dataZip(files, meta.lastUpdated);
      } finally {
        vi.unstubAllEnvs();
      }
    };
    const zip = zipIn('UTC');
    expect(Buffer.from(zipIn('Pacific/Kiritimati')).equals(Buffer.from(zip))).toBe(true);
    expect(Buffer.from(zipIn('America/Los_Angeles')).equals(Buffer.from(zip))).toBe(true);
    const unzipped = unzipSync(zip);
    expect(Object.keys(unzipped)).toEqual(files.map((f) => `data/${f.name}`).sort());
    expect(strFromU8(unzipped['data/meta.yaml'] ?? new Uint8Array())).toBe(
      readFileSync(join(root, 'data', 'meta.yaml'), 'utf8'),
    );
  });
});

describe('verdict', () => {
  const tag = 'mfm-v1.6+2026-10-22';

  it('publishes a tag not released yet', () => {
    expect(verdict(tag, SHA, undefined)).toEqual({
      publish: true,
      reason: 'no release is tagged mfm-v1.6+2026-10-22 yet',
    });
  });

  it('publishes nothing for a tag released at this commit, or with the same data', () => {
    expect(verdict(tag, SHA, { commit: SHA, sameData: true }).publish).toBe(false);
    expect(verdict(tag, SHA, { commit: OTHER, sameData: true })).toEqual({
      publish: false,
      reason: `data/ is unchanged since mfm-v1.6+2026-10-22, released at ${OTHER}`,
    });
  });

  it('fails a tag released with other data, which means no new changelog entry', () => {
    expect(() => verdict(tag, SHA, { commit: OTHER, sameData: false })).toThrow(
      /released already, at b{40}, with other data than a{40}\. .*without a new entry/,
    );
  });
});

describe('historicalVerdict', () => {
  const tag = 'mfm-v1.0+2026-06-22';
  const ours = [
    { name: 'all.json', sha256: '1'.repeat(64) },
    { name: 'data.zip', sha256: '2'.repeat(64) },
  ];
  const assets = (zip = '2'.repeat(64)) => [
    { name: 'data.zip', digest: `sha256:${zip}` },
    { name: 'all.json', digest: `sha256:${'1'.repeat(64)}` },
  ];

  it('publishes a past release GitHub lacks, and skips one it has with the same assets', () => {
    expect(historicalVerdict(tag, SHA, ours, undefined).publish).toBe(true);
    expect(historicalVerdict(tag, SHA, ours, { commit: SHA, assets: assets() })).toEqual({
      publish: false,
      reason: 'mfm-v1.0+2026-06-22 is released already, with identical assets',
    });
  });

  it('skips one whose bytes the current tools build differently: a release cannot change', () => {
    const v = historicalVerdict(tag, SHA, ours, { commit: SHA, assets: assets('3'.repeat(64)) });
    expect(v.publish).toBe(false);
    expect(v.reason).toContain('build data.zip differently, and the published ones stand');
  });

  it('fails one at another commit, or with other assets', () => {
    expect(() => historicalVerdict(tag, SHA, ours, { commit: OTHER, assets: assets() })).toThrow(
      `is released at ${OTHER}, but release/history.json says ${SHA}`,
    );
    const fewer = { commit: SHA, assets: assets().slice(1) };
    expect(() => historicalVerdict(tag, SHA, ours, fewer)).toThrow('is released with the assets');
  });
});

describe('mfm release', () => {
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

  let server: Server | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise((done) => server?.close(done));
    server = undefined;
  });

  interface Published {
    commit: string;
    annotated?: boolean;
    /** Its assets' SHA-256s, by name. */
    assets?: Record<string, string>;
  }

  /**
   * A GitHub API with the releases `released` names: each one's tag points at its commit
   * (through an annotated tag object with `annotated`). `data/` is the tree `trees[commit]`
   * at each commit.
   */
  async function github(
    released: Record<string, Published> = {},
    trees: Record<string, string> = {},
  ) {
    const calls: string[] = [];
    const repo = '/repos/BSData/wh40k-11e-mfm';
    const routes = (url: string): unknown => {
      const tagIn = (prefix: string) =>
        url.startsWith(prefix) ? decodeURIComponent(url.slice(prefix.length)) : undefined;
      const release = released[tagIn(`${repo}/releases/tags/`) ?? ''];
      if (release) {
        return {
          target_commitish: 'main',
          assets: Object.entries(release.assets ?? {}).map(([name, sha]) => ({
            name,
            digest: `sha256:${sha}`,
          })),
        };
      }
      const ref = released[tagIn(`${repo}/git/ref/tags/`) ?? ''];
      if (ref) {
        return ref.annotated
          ? { object: { sha: 'c'.repeat(40), type: 'tag' } }
          : { object: { sha: ref.commit, type: 'commit' } };
      }
      if (url === `${repo}/git/tags/${'c'.repeat(40)}`) {
        const annotated = Object.values(released).find((r) => r.annotated);
        return annotated && { object: { sha: annotated.commit, type: 'commit' } };
      }
      const commit = url.match(/\/git\/trees\/([0-9a-f]{40})$/)?.[1];
      if (commit) {
        const data = trees[commit];
        return { tree: data ? [{ path: 'data', type: 'tree', sha: data }] : [] };
      }
      return undefined;
    };
    server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      req.resume();
      const body = routes(req.url ?? '');
      res
        .writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
        .end(JSON.stringify(body ?? { message: 'Not Found' }));
    });
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    vi.stubEnv('GITHUB_API_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('GITHUB_REPOSITORY', 'BSData/wh40k-11e-mfm');
    vi.stubEnv('GH_TOKEN', 't0ken');
    return calls;
  }

  /** `mfm release` on `root` into a fresh --out; `args` are added to the command. */
  async function release(args: string[] = [], root = frozenRepository(scratch)) {
    const out = join(mkdtempSync(join(scratch, 'out-')), 'release');
    const output = join(out, '..', 'github-output');
    const run = await mfm(
      'release',
      '--root',
      root,
      '--out',
      out,
      '--output',
      output,
      '--today',
      '2026-10-23',
      ...args,
    );
    const read = (path: string) => readFileSync(join(out, path), 'utf8');
    const plan = () =>
      read('plan.tsv')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\t'));
    return { ...run, out, read, plan, outputs: () => readFileSync(output, 'utf8') };
  }

  const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const ASSETS = [
    'all.json',
    'all.schema.json',
    'data.zip',
    'faction.schema.json',
    'meta.schema.json',
    'points.csv',
  ];

  it('builds the current release alone when the history table is empty', async () => {
    const { code, stdout, out, read, plan, outputs } = await release();
    expect(code).toBe(0);
    expect(plan()).toEqual([['mfm-v1.6+2026-10-22', '', 'current', '01']]);
    expect(readdirSync(join(out, '01', 'assets')).sort()).toEqual(ASSETS);
    expect(read('01/title.txt')).toBe('MFM v1.6 — 2026-10-20 → 2026-10-22');
    expect(read('01/notes.md')).toContain('moved to Legends');
    // The notes link the commit's copy only when there is a commit to link.
    expect(read('01/notes.md')).toContain('/blob/main/specs/data-model.md#names');
    expect(outputs()).toBe('tag=mfm-v1.6+2026-10-22\ntitle=MFM v1.6 — 2026-10-20 → 2026-10-22\n');
    expect(stdout).toContain('## Release plan: 1 release, oldest first\n');
    expect(stdout).toMatch(/ {2}data\.zip +\d+ bytes {2}sha256:[0-9a-f]{64}\n/);
    expect(stdout).toContain('Not checked against GitHub');
    expect(read('summary.md')).toBe(stdout.slice(0, stdout.lastIndexOf('1 of 1')));
  });

  describe('with past releases', () => {
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
      )
        .toString()
        .trim();

    /**
     * A repository whose history has two past data commits, a schema-1 snapshot (MFM
     * v1.3's Necrons) and then a schema-2 one (v1.6's), each a row of its history table,
     * and the frozen dataset as its current state.
     */
    function repository(): { root: string; first: string; second: string } {
      const root = mkdtempSync(join(scratch, 'history-'));
      git(root, 'init');
      const commitData = (from: string) => {
        rmSync(join(root, 'data'), { recursive: true, force: true });
        mkdirSync(join(root, 'data'));
        for (const name of ['meta.yaml', 'necrons.yaml']) {
          writeFileSync(join(root, 'data', name), readFileSync(join(GOLDEN, from, name)));
        }
        git(root, 'add', '-A');
        git(root, 'commit', '-m', from);
        return git(root, 'rev-parse', 'HEAD');
      };
      const first = commitData('data-v1.3-schema1');
      const second = commitData('data-v1.6');
      const current = frozenRepository(scratch);
      rmSync(join(root, 'data'), { recursive: true });
      cpSync(current, root, { recursive: true });
      const table = [
        {
          tag: 'mfm-v1.6+2026-10-01',
          commit: first,
          pr: null,
          version: '1.6',
          title: 'MFM v1.6 — 2026-10-01: Baseline',
          entries: [],
          notes: '## [2026-10-01] — MFM v1.6 baseline\n\nThe first one.',
          schema1: true,
        },
        {
          tag: 'mfm-v1.6+2026-10-14',
          commit: second,
          pr: 64,
          version: '1.6',
          title: 'MFM v1.6 — 2026-10-14',
          entries: ['## [2026-10-14] — MFM v1.6'],
          schema1: false,
          caveats: ['A caveat.'],
        },
      ];
      writeFileSync(join(root, 'release', 'history.json'), `${JSON.stringify(table, null, 2)}\n`);
      git(root, 'add', '-A');
      git(root, 'commit', '-m', 'current');
      return { root, first, second };
    }

    it('plans them first, oldest first, each built from its own commit', async () => {
      const { root, first, second } = repository();
      const { code, out, read, plan } = await release([], root);
      expect(code).toBe(0);
      expect(plan()).toEqual([
        ['mfm-v1.6+2026-10-01', first, 'history', '01'],
        ['mfm-v1.6+2026-10-14', second, 'history', '02'],
        ['mfm-v1.6+2026-10-22', '', 'current', '03'],
      ]);
      expect(read('01/title.txt')).toBe('MFM v1.6 — 2026-10-01: Baseline');
      const baseline = read('01/notes.md');
      expect(baseline).toMatch(
        /^## \[2026-10-01\] — MFM v1\.6 baseline\n\nThe first one\.\n\n\*\*Backfilled\*\* on 2026-10-23 from \[`[0-9a-f]{7}`\]\(https:\/\/github\.com\/BSData\/wh40k-11e-mfm\/commit\/[0-9a-f]{40}\): /,
      );
      expect(baseline).toContain("- Converted from schema 1 with #41's mapping");
      expect(baseline).toMatch(
        /- \d+ names are cased as they were before #88, such as `[^`]+` \(now `[^`]+`\)/,
      );
      // The schema-1 snapshot, in the current shape: v1.3's Necrons, with leaderTo lists.
      const all = Dataset.parse(
        JSON.parse(readFileSync(join(out, '01', 'assets', 'all.json'), 'utf8')),
      );
      expect(all.schemaVersion).toBe(2);
      expect(all.meta.version).toBe('1.3');
      expect(all.factions[0]?.units.some((u) => u.leaderTo)).toBe(true);
      const zip = unzipSync(readFileSync(join(out, '01', 'assets', 'data.zip')));
      expect(Object.keys(zip).sort()).toEqual([
        'data/meta.yaml',
        'data/necrons.yaml',
        'data/points.csv',
      ]);
      expect(strFromU8(zip['data/meta.yaml'] ?? new Uint8Array())).toMatch(
        /^schemaVersion: 2\nversion: "1\.3"\n/,
      );

      const second_ = read('02/notes.md');
      expect(second_).toMatch(/^## \[2026-10-14\] — MFM v1\.6\n/);
      expect(second_).toContain(', from #64: `data/` as `main` had it then');
      expect(second_).toContain('\n- A caveat.\n');
      expect(second_).not.toContain('Converted from schema 1');
    });

    it('with --commit: plans only what GitHub lacks, and skips what it has', async () => {
      const { root, first } = repository();
      const built = await release([], root);
      const assets = Object.fromEntries(
        ASSETS.map((n) => [n, sha256(join(built.out, '01', 'assets', n))]),
      );
      const calls = await github({ 'mfm-v1.6+2026-10-01': { commit: first, assets } });
      const { code, stdout, plan, outputs } = await release(['--commit', SHA], root);
      expect(code).toBe(0);
      expect(plan().map(([tag, , kind, dir]) => [tag, kind, dir])).toEqual([
        ['mfm-v1.6+2026-10-14', 'history', '02'],
        ['mfm-v1.6+2026-10-22', 'current', '03'],
      ]);
      expect(plan()[1]?.[1]).toBe(SHA);
      expect(stdout).toContain(
        '### 1. `mfm-v1.6+2026-10-01`: skip (mfm-v1.6+2026-10-01 is released already, with identical assets)',
      );
      expect(stdout).toContain(
        '### 2. `mfm-v1.6+2026-10-14`: publish (no release is tagged mfm-v1.6+2026-10-14 yet)',
      );
      expect(outputs()).toMatch(/\npublish=true\nreason=2 of 3 releases to publish\n$/);
      expect(calls).toContain(
        'GET /repos/BSData/wh40k-11e-mfm/releases/tags/mfm-v1.6%2B2026-10-01',
      );
    });

    it('with --commit: plans nothing when every release exists', async () => {
      const { root, first, second } = repository();
      const built = await release([], root);
      const assets = (dir: string) =>
        Object.fromEntries(ASSETS.map((n) => [n, sha256(join(built.out, dir, 'assets', n))]));
      await github({
        'mfm-v1.6+2026-10-01': { commit: first, assets: assets('01') },
        'mfm-v1.6+2026-10-14': { commit: second, assets: assets('02'), annotated: true },
        'mfm-v1.6+2026-10-22': { commit: SHA },
      });
      const { code, plan, outputs } = await release(['--commit', SHA], root);
      expect(code).toBe(0);
      expect(plan()).toEqual([]);
      expect(outputs()).toMatch(/\npublish=false\nreason=nothing to publish\n$/);
    });

    it('with --commit: fails a past release GitHub has at another commit', async () => {
      const { root } = repository();
      await github({ 'mfm-v1.6+2026-10-14': { commit: OTHER, assets: {} } });
      await expect(release(['--commit', SHA], root)).rejects.toThrow(
        `mfm-v1.6+2026-10-14 is released at ${OTHER}, but release/history.json says`,
      );
    });
  });

  it('with --commit: publishes nothing when data/ is unchanged since the current release', async () => {
    const calls = await github(
      { 'mfm-v1.6+2026-10-22': { commit: OTHER } },
      { [SHA]: 'd1', [OTHER]: 'd1' },
    );
    const { code, plan, outputs, stdout } = await release(['--commit', SHA]);
    expect(code).toBe(0);
    expect(plan()).toEqual([]);
    expect(outputs()).toMatch(/\npublish=false\n/);
    expect(stdout).toContain('skip (data/ is unchanged since mfm-v1.6+2026-10-22');
    expect(calls).toContain(`GET /repos/BSData/wh40k-11e-mfm/git/trees/${OTHER}`);
  });

  it('with --commit: fails for a current tag released with other data', async () => {
    await github({ 'mfm-v1.6+2026-10-22': { commit: OTHER } }, { [SHA]: 'd2', [OTHER]: 'd1' });
    await expect(release(['--commit', SHA])).rejects.toThrow('with other data');
  });

  it('refuses data that check-data fails, writing nothing', async () => {
    const root = frozenRepository(scratch, (r) => {
      const csv = join(r, 'data', 'points.csv');
      writeFileSync(
        csv,
        readFileSync(csv, 'utf8').replace(/,(\d+),/, (_, n) => `,${Number(n) + 5},`),
      );
    });
    const { code, stderr, out } = await release([], root);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ data\/points\.csv is not canonical/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an --out with files in it, since its plan would be published', async () => {
    const out = mkdtempSync(join(scratch, 'out-'));
    writeFileSync(join(out, 'plan.tsv'), 'stale\n');
    await expect(mfm('release', '--root', frozenRepository(scratch), '--out', out)).rejects.toThrow(
      "isn't empty",
    );
  });

  it.each([
    ['--commit', 'main', '--commit must be a full commit SHA'],
    ['--commit', SHA.slice(0, 7), '--commit must be a full commit SHA'],
    ['--today', '23 October', '--today must be a date'],
  ])('refuses %s %s', async (option, value, message) => {
    const { code, stderr } = await release([option, value]);
    expect(code).toBe(2);
    expect(stderr).toContain(message);
  });
});
