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
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/bin/mfm.js';
import { ENTRIES_MARKER } from '../src/changelog.js';
import { loadFactionDir } from '../src/diff.js';
import { metaFromYaml } from '../src/emit.js';
import { Dataset } from '../src/model.js';
import { verdict } from '../src/ops/release.js';
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

  /**
   * A GitHub API holding one release, if `released` says where: its tag points at
   * `released.commit` (through an annotated tag object with `annotated`), and `data/` is the
   * tree `trees[commit]` at each commit.
   */
  async function github(
    released?: { commit: string; annotated?: boolean },
    trees: Record<string, string> = {},
  ) {
    const calls: string[] = [];
    const repo = '/repos/BSData/wh40k-11e-mfm';
    const routes = (url: string): unknown => {
      if (!released) return undefined;
      if (url.startsWith(`${repo}/releases/tags/`)) return { target_commitish: 'main' };
      if (url.startsWith(`${repo}/git/ref/tags/`)) {
        return released.annotated
          ? { object: { sha: 'c'.repeat(40), type: 'tag' } }
          : { object: { sha: released.commit, type: 'commit' } };
      }
      if (url === `${repo}/git/tags/${'c'.repeat(40)}`) {
        return { object: { sha: released.commit, type: 'commit' } };
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

  /** A fresh repository and where its release goes; `args` are added to the command. */
  async function release(args: string[] = [], root = frozenRepository(scratch)) {
    const out = mkdtempSync(join(scratch, 'out-'));
    const paths = {
      assets: join(out, 'assets'),
      notes: join(out, 'notes.md'),
      output: join(out, 'github-output'),
    };
    const run = await mfm(
      'release',
      '--root',
      root,
      '--assets',
      paths.assets,
      '--notes-file',
      paths.notes,
      '--output',
      paths.output,
      ...args,
    );
    return { ...run, ...paths };
  }

  it('builds every asset and the notes, and prints them, without asking GitHub', async () => {
    const { code, stdout, assets, notes, output } = await release();
    expect(code).toBe(0);
    expect(readdirSync(assets)).toEqual(
      [
        'all.json',
        'points.csv',
        'faction.schema.json',
        'meta.schema.json',
        'all.schema.json',
        'data.zip',
      ].sort(),
    );
    expect(readFileSync(output, 'utf8')).toBe(
      'tag=mfm-v1.6+2026-10-22\ntitle=MFM v1.6 — 2026-10-20 → 2026-10-22\n',
    );
    expect(readFileSync(notes, 'utf8')).toContain('moved to Legends');
    expect(stdout).toMatch(
      /^Tag: {3}mfm-v1\.6\+2026-10-22\nTitle: MFM v1\.6 — 2026-10-20 → 2026-10-22\n/,
    );
    expect(stdout).toMatch(/ {2}data\.zip +\d+ bytes {2}sha256:[0-9a-f]{64}\n/);
    expect(stdout).toContain('Not checked against GitHub: no --commit.\n');
    // The notes link the commit's copy only when there is a commit to link.
    expect(readFileSync(notes, 'utf8')).toContain('/blob/main/specs/data-model.md#names');
  });

  it('with --commit: publishes a tag not released yet', async () => {
    const calls = await github();
    const { code, stdout, output, notes } = await release(['--commit', SHA]);
    expect(code).toBe(0);
    expect(calls).toEqual(['GET /repos/BSData/wh40k-11e-mfm/releases/tags/mfm-v1.6%2B2026-10-22']);
    expect(readFileSync(output, 'utf8')).toMatch(
      /\npublish=true\nreason=no release is tagged mfm-v1\.6\+2026-10-22 yet\n$/,
    );
    expect(stdout).toContain('To publish: no release is tagged mfm-v1.6+2026-10-22 yet.\n');
    expect(readFileSync(notes, 'utf8')).toContain(`/blob/${SHA}/specs/data-model.md#names`);
  });

  it('with --commit: publishes nothing for a tag released at this commit', async () => {
    await github({ commit: SHA });
    const { code, output } = await release(['--commit', SHA]);
    expect(code).toBe(0);
    expect(readFileSync(output, 'utf8')).toMatch(/\npublish=false\nreason=.* at this commit\n$/);
  });

  it.each([false, true])(
    'with --commit: publishes nothing when data/ is unchanged since the release (annotated tag: %s)',
    async (annotated) => {
      const calls = await github({ commit: OTHER, annotated }, { [SHA]: 'd1', [OTHER]: 'd1' });
      const { code, output, stdout } = await release(['--commit', SHA]);
      expect(code).toBe(0);
      expect(readFileSync(output, 'utf8')).toMatch(/\npublish=false\n/);
      expect(stdout).toContain(`Nothing to publish: data/ is unchanged since mfm-v1.6+2026-10-22`);
      expect(calls).toContain(`GET /repos/BSData/wh40k-11e-mfm/git/trees/${OTHER}`);
    },
  );

  it('with --commit: fails for a tag released with other data', async () => {
    await github({ commit: OTHER }, { [SHA]: 'd2', [OTHER]: 'd1' });
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
    const { code, stderr, assets } = await release([], root);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ data\/points\.csv is not canonical/);
    expect(existsSync(assets)).toBe(false);
  });

  it('refuses an assets directory with files in it, since all of them would be uploaded', async () => {
    const out = mkdtempSync(join(scratch, 'out-'));
    mkdirSync(join(out, 'assets'));
    writeFileSync(join(out, 'assets', 'stale.json'), '{}');
    const root = frozenRepository(scratch);
    await expect(
      mfm(
        'release',
        '--root',
        root,
        '--assets',
        join(out, 'assets'),
        '--notes-file',
        join(out, 'n.md'),
      ),
    ).rejects.toThrow("isn't empty");
  });

  it.each([
    ['--commit', 'main'],
    ['--commit', SHA.slice(0, 7)],
  ])('refuses %s %s', async (...args) => {
    const { code, stderr } = await release(args);
    expect(code).toBe(2);
    expect(stderr).toContain('--commit must be a full commit SHA');
  });
});
