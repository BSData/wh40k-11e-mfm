import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ENTRIES_MARKER } from '../src/changelog.js';
import { factionToYaml, metaToYaml } from '../src/emit.js';
import {
  fieldsUsed,
  fromSchema1,
  HISTORY_FILE,
  namesCasedOtherwise,
  parseHistory,
  parseUnreleased,
  snapshotOf,
  TAG,
  UNRELEASED_FILE,
} from '../src/history.js';
import { filesAt } from '../src/ops/git.js';
import { gitEnv } from '../src/ops/git-env.js';
import {
  chronological,
  entriesOf,
  previousRelease,
  releaseTag,
  releaseTitle,
} from '../src/release.js';

/**
 * The past releases (see "Releases" in specs/data-model.md): the reviewed table in
 * release/history.json, the conversion of schema-1 data, and reading a commit's data/.
 */

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), 'utf8');
const history = parseHistory(read(HISTORY_FILE));
const unreleased = parseUnreleased(read(UNRELEASED_FILE));

const lastDay = (window: string) => window.split(' → ').at(-1) ?? '';
const dateOf = (tag: string) => tag.match(/\+(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
const changelog = (version: string) => read(`changelog/v${version}.md`);

describe('release/history.json', () => {
  it('lists the past releases, each once, in the order they are published', () => {
    expect(history.length).toBeGreaterThan(5);
    expect(new Set(history.map((h) => h.tag)).size).toBe(history.length);
    expect(new Set(history.map((h) => h.commit)).size).toBe(history.length);
    const dates = history.map((h) => dateOf(h.tag));
    // Strictly later each time: the releases read oldest to newest.
    expect(dates).toEqual([...new Set(dates)].sort());
  });

  it.each(history)('$tag is tagged and titled as its changelog entries name it', (h) => {
    expect(h.tag).toMatch(TAG);
    if (h.entries.length === 0) {
      // The baseline: its own notes, headed like an entry.
      const window = h.notes?.match(/^## \[([^\]]+)\]/)?.[1] ?? '';
      expect(h.tag).toBe(`mfm-v${h.version}+${lastDay(window)}`);
      return;
    }
    const all = entriesOf(changelog(h.version));
    const first = all.findIndex((e) => e.heading === h.entries[0]);
    const newest = all[first];
    if (!newest) throw new Error(`${h.entries[0]} isn't in changelog/v${h.version}.md`);
    // The counting rule, as if this were the newest entry: older entries ending the same
    // day that this release doesn't fold in would each push it one number on.
    const others = all
      .slice(first + 1)
      .filter(
        (e) => lastDay(e.window) === lastDay(newest.window) && !h.entries.includes(e.heading),
      );
    expect(h.tag).toBe(releaseTag(h.version, newest.window, 1 + others.length));
    expect(h.title).toBe(releaseTitle(h.version, newest));
  });

  it("names each entry it folds in as its version's file has it, once, in one row", () => {
    for (const h of history) {
      for (const heading of h.entries) {
        expect(entriesOf(changelog(h.version)).filter((e) => e.heading === heading)).toHaveLength(
          1,
        );
      }
    }
    const all = history.flatMap((h) => h.entries.map((e) => `${h.version} ${e}`));
    expect(new Set(all).size).toBe(all.length);
  });

  it('has the notes files its rows name', () => {
    for (const h of history.filter((h) => h.notesFile)) {
      expect(read(`release/${h.notesFile}`)).toMatch(/^## \[/);
    }
  });

  /** Every changelog entry but the unreleased ones, oldest first across the versions. */
  const released = () => {
    const files = readdirSync(root('changelog')).map((name) => ({
      version: name.replace(/^v|\.md$/g, ''),
      text: read(`changelog/${name}`),
    }));
    return chronological(files).filter(
      (e) => !unreleased.some((u) => u.version === e.version && u.heading === e.heading),
    );
  };
  const inRow = (e: { version: string; heading: string }) =>
    history.some((h) => h.version === e.version && h.entries.includes(e.heading));
  /** The tag the counting rule gives an entry, as if it were the newest. */
  const ruleTag = (e: ReturnType<typeof released>[number]) =>
    releaseTag(
      e.version,
      e.window,
      1 + e.older.filter((o) => lastDay(o.window) === lastDay(e.window)).length,
    );

  it('accounts for the entries from the first up to its last row, and none after', () => {
    const covered = released().map(inRow);
    const after = covered.indexOf(false);
    expect(after).toBeGreaterThan(0);
    // What follows is the current release and the ones after it, named by the counting
    // rule; nothing there belongs in the table.
    expect(covered.slice(after).every((c) => !c)).toBe(true);
  });

  it('is the release before the first one after it, which that one checks for', () => {
    const entries = released();
    const after = entries.findIndex((e) => !inRow(e));
    const first = entries[after];
    if (!first) throw new Error('every entry is a row');
    // The changelog files as they were when that entry was the newest.
    const files = [...new Set(entries.slice(0, after + 1).map((e) => e.version))].map(
      (version) => ({
        version,
        text: `${ENTRIES_MARKER}\n\n${entries
          .slice(0, after + 1)
          .filter((e) => e.version === version)
          .reverse()
          .map((e) => e.text)
          .join('\n\n')}\n`,
      }),
    );
    expect(previousRelease(files, history, first.version, unreleased)?.tag).toBe(
      history.at(-1)?.tag,
    );
  });

  it('takes no tag a later entry can get', () => {
    const entries = released();
    const tags = new Set(history.map((h) => h.tag));
    const last = dateOf(history.at(-1)?.tag ?? '');
    for (const e of entries.filter((e) => !inRow(e))) {
      expect(tags.has(ruleTag(e)), e.heading).toBe(false);
      // A later entry ends on the day of the table's last row or after it.
      expect(lastDay(e.window) >= last, e.heading).toBe(true);
    }
  });

  it('has a valid list of the entries without a release', () => {
    for (const u of unreleased) {
      expect(entriesOf(changelog(u.version)).some((e) => e.heading === u.heading)).toBe(true);
      expect(inRow(u)).toBe(false);
    }
  });

  it('converts the schema-1 releases, which all come first', () => {
    const firstSchema2 = history.findIndex((h) => !h.schema1);
    expect(firstSchema2).toBeGreaterThan(0);
    expect(history.slice(firstSchema2).every((h) => !h.schema1)).toBe(true);
    // #41 made the change after MFM v1.3.
    expect(history.filter((h) => h.schema1).every((h) => Number(h.version) <= 1.3)).toBe(true);
  });
});

describe('fromSchema1, #41’s mapping', () => {
  const faction = (over: { units?: unknown[]; detachments?: unknown[] }) => ({
    name: 'Necrons',
    slug: 'necrons',
    version: '1.3',
    firstSeen: '2026-08-26',
    detachments: [],
    units: [],
    ...over,
  });

  it("turns a unit's role and attachTo into leaderTo or supportTo", () => {
    const units = [
      { name: 'Overlord', role: 'leader', attachTo: ['Immortals'] },
      { name: 'Technomancer', role: 'support', attachTo: ['Immortals', 'Necron Warriors'] },
      { name: 'Necron Warriors' },
    ];
    expect(fromSchema1(faction({ units }), 'x')).toMatchObject({
      units: [
        { name: 'Overlord', leaderTo: ['Immortals'] },
        { name: 'Technomancer', supportTo: ['Immortals', 'Necron Warriors'] },
        { name: 'Necron Warriors' },
      ],
    });
    const [overlord] = (fromSchema1(faction({ units }), 'x') as { units: object[] }).units;
    expect(overlord).not.toHaveProperty('role');
    expect(overlord).not.toHaveProperty('attachTo');
  });

  it("turns a detachment's objective into objectives, empty for none", () => {
    const detachments = [
      { name: 'A', dp: 2, objective: 'PURGE THE FOE', enhancements: [] },
      { name: 'B', dp: 1, objective: null, enhancements: [] },
    ];
    expect(fromSchema1(faction({ detachments }), 'x')).toEqual(
      faction({
        detachments: [
          { name: 'A', dp: 2, objectives: ['PURGE THE FOE'], enhancements: [] },
          { name: 'B', dp: 1, objectives: [], enhancements: [] },
        ],
      }),
    );
  });

  it.each([
    ['a role without attachTo', { units: [{ name: 'U', role: 'leader' }] }],
    ['attachTo without a role', { units: [{ name: 'U', attachTo: ['V'] }] }],
    ['a role it never had', { units: [{ name: 'U', role: 'warlord', attachTo: [] }] }],
    ['a detachment without objective', { detachments: [{ name: 'D', enhancements: [] }] }],
    ['a list for objective', { detachments: [{ name: 'D', objective: ['A'], enhancements: [] }] }],
  ])('refuses %s, naming where', (_, over) => {
    expect(() => fromSchema1(faction(over), 'data/necrons.yaml')).toThrow(/^data\/necrons\.yaml: /);
  });

  it('gives exactly the data #41 migrated by hand: MFM v1.3, before and after', () => {
    const dir = (name: string) => root(`test/golden/${name}`);
    const files = (name: string) =>
      readdirSync(dir(name)).map((f) => ({
        name: f,
        text: readFileSync(join(dir(name), f), 'utf8'),
      }));
    const before = files('data-v1.3-schema1');
    expect(before.some((f) => /^ {4}role: /m.test(f.text))).toBe(true);
    const { meta, factions } = snapshotOf(before, true);
    const after = files('data-v1.3');
    expect(factions).toHaveLength(after.length - 1);
    for (const f of factions) {
      expect(factionToYaml(f), f.slug).toBe(after.find((a) => a.name === `${f.slug}.yaml`)?.text);
    }
    // meta.yaml gains only schemaVersion.
    expect(metaToYaml(meta)).toBe(
      `schemaVersion: 2\n${after.find((a) => a.name === 'meta.yaml')?.text}`,
    );
  });
});

describe('snapshotOf', () => {
  const meta = 'version: "1.6"\nlastUpdated: 2026-10-14\nfactions:\n  - necrons\n';
  // The committed file: its names are cased by the current rule.
  const necrons = read('data/necrons.yaml');

  it('gives meta.yaml the current schemaVersion', () => {
    const s = snapshotOf(
      [
        { name: 'meta.yaml', text: meta },
        { name: 'necrons.yaml', text: necrons },
      ],
      false,
    );
    expect(s.meta.schemaVersion).toBe(2);
    expect(s.factions.map((f) => f.slug)).toEqual(['necrons']);
  });

  it('fails on a field the model would drop, rather than drop it', () => {
    const files = [
      { name: 'meta.yaml', text: meta },
      {
        name: 'necrons.yaml',
        text: necrons.replace('slug: necrons\n', 'slug: necrons\ncodex: 10\n'),
      },
    ];
    expect(() => snapshotOf(files, false)).toThrow(
      "fields the model doesn't know: data/necrons.yaml.codex",
    );
  });

  it('fails without meta.yaml', () => {
    expect(() => snapshotOf([{ name: 'necrons.yaml', text: necrons }], false)).toThrow(
      'data/meta.yaml is missing',
    );
  });

  it('names the fields used, and the names cased otherwise than now', () => {
    const s = snapshotOf(
      [
        { name: 'meta.yaml', text: meta },
        {
          name: 'necrons.yaml',
          text: necrons.replace('Imotekh the Stormlord', 'Imotekh The Stormlord'),
        },
      ],
      false,
    );
    expect(fieldsUsed(s)).toContain('unit.leaderTo');
    expect(fieldsUsed(s)).not.toContain('meta.muster');
    expect(namesCasedOtherwise(s)).toEqual(['Imotekh The Stormlord']);
  });
});

describe('filesAt, a commit’s data/', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'mfm-history-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
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

  it('reads every file directly under the directory, as committed then', async () => {
    const repo = mkdtempSync(join(scratch, 'repo-'));
    git(repo, 'init');
    mkdirSync(join(repo, 'data', 'nested'), { recursive: true });
    writeFileSync(join(repo, 'data', 'meta.yaml'), 'version: "1.0"\n');
    writeFileSync(join(repo, 'data', 'necrons.yaml'), 'name: Necrons ’\n');
    writeFileSync(join(repo, 'data', 'nested', 'x.yaml'), 'not read\n');
    writeFileSync(join(repo, 'README.md'), 'not data\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'one');
    const first = git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'data', 'necrons.yaml'), 'name: Necrons, later\n');
    git(repo, 'commit', '-am', 'two');

    const files = await filesAt(repo, first, 'data');
    expect(files.map((f) => [f.name, f.data.toString('utf8')])).toEqual([
      ['meta.yaml', 'version: "1.0"\n'],
      ['necrons.yaml', 'name: Necrons ’\n'],
    ]);
    await expect(filesAt(repo, 'f'.repeat(40), 'data')).rejects.toThrow(/^git ls-tree/);
  });
});
