import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../src/bin/mfm.js';
import { changelog, changelogEntry, loadFactionDir, loadMeta, updateTitle } from '../src/diff.js';
import { announcement } from '../src/discord.js';
import { factionToYaml, metaToYaml, type SiteMeta } from '../src/emit.js';
import type { Faction, Unit } from '../src/model.js';
import { planUpdate, type UpdatePr } from '../src/stack.js';

/**
 * Golden tests: what the scrape workflow publishes for an update — the PR title and body,
 * the changelog entry, the Discord payload and the update-PR plan — pinned byte for byte
 * under `test/golden/`, on realistic snapshot pairs built from a real dataset: `data/` as
 * of MFM v1.6, frozen in `test/golden/data-v1.6/` so a data update doesn't move them.
 *
 * Each output is checked twice: from the functions, and from the commands the workflow
 * runs. A refactor must leave every golden file untouched. A deliberate change to what is
 * published regenerates them (`pnpm test -u`), and the review then reads the change as a
 * diff of the published text.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'test', 'golden', 'data-v1.6');
const TODAY = '2026-10-23';
const PR = { prNumber: 78, prUrl: 'https://github.com/BSData/wh40k-11e-mfm/pull/78' };

const before = loadFactionDir(DATA);
const beforeMeta = loadMeta(DATA);
if (!beforeMeta) throw new Error(`${DATA}/meta.yaml has no site version`);

// ---- Building the scraped side ---------------------------------------------------

function faction(fs: Faction[], slug: string): Faction {
  const f = fs.find((x) => x.slug === slug);
  if (!f) throw new Error(`no faction ${slug}`);
  return f;
}

function unit(f: Faction, name: string, nth = 0): Unit {
  const u = f.units.filter((x) => x.name === name)[nth];
  if (!u) throw new Error(`${f.slug}: no unit ${name} #${nth + 1}`);
  return u;
}

/** Move one cost option of a unit, the first of its first tier by default. */
function reprice(u: Unit, delta: number, tier = 0, option = 0): void {
  const cost = u.pricing[tier]?.costs[option];
  if (!cost) throw new Error(`${u.name}: no cost ${tier}/${option}`);
  cost.points += delta;
}

/** A single-tier unit picking up a `3rd+` threshold that costs `delta` more. */
function addThirdPlusTier(u: Unit, delta: number): void {
  const [only] = u.pricing;
  if (!only || u.pricing.length !== 1) throw new Error(`${u.name} is already tiered`);
  u.pricing = [
    { ...only, range: '[1,2]', label: 'Your 1st To 2nd Units Cost' },
    {
      range: '[3,)',
      label: 'Your 3rd + Unit Costs',
      costs: only.costs.map((c) => ({ ...c, points: c.points + delta })),
    },
  ];
}

/** The Space Marines page and every sub-faction page, which carries its roster too. */
const spaceMarines = (fs: Faction[]) =>
  fs.filter((f) => f.slug === 'space-marines' || f.parent === 'Space Marines');

interface Case {
  name: string;
  /** Turns a copy of the committed snapshot into the scraped one. */
  scrape: (factions: Faction[], meta: SiteMeta) => Faction[];
  /** Dated partly by today (a removed faction, a rules panel change): no CLI run here. */
  datedToday?: boolean;
}

const CASES: Case[] = [
  { name: 'unchanged', scrape: (fs) => fs },
  {
    // A routine update over three days: reprices, a unit in and a unit out, a Leader
    // list, a detachment, an enhancement, wargear, a family-wide reprice, one only the
    // sub-factions take, and the second of two same-named units.
    name: 'repriced',
    scrape: (fs) => {
      const necrons = faction(fs, 'necrons');
      necrons.firstSeen = '2026-10-20';
      reprice(unit(necrons, 'Necron Warriors'), 5);
      reprice(unit(necrons, 'Immortals'), -5, 0, 1);
      unit(necrons, 'Overlord').leaderTo = ['Immortals', 'Necron Warriors'];
      const [legion] = necrons.detachments;
      if (!legion?.enhancements[0]) throw new Error('necrons: no first detachment');
      legion.dp = 3;
      legion.enhancements[0].points += 5;
      necrons.units = necrons.units.filter((u) => u.name !== 'Nekrosor Ammentar');
      necrons.units.push({ ...structuredClone(unit(necrons, 'Immortals')), name: 'Tomb Sentinel' });

      for (const f of spaceMarines(fs)) {
        f.firstSeen = '2026-10-21';
        reprice(unit(f, 'Intercessor Squad'), 5);
        if (f.parent) reprice(unit(f, 'Assault Intercessor Squad'), -5);
      }
      reprice(unit(faction(fs, 'space-wolves'), 'Venerable Dreadnought', 1), 10);

      const agents = faction(fs, 'imperial-agents');
      agents.firstSeen = '2026-10-22';
      reprice(unit(agents, 'Inquisitor', 1), 5);
      const orks = faction(fs, 'orks');
      orks.firstSeen = '2026-10-22';
      const zzap = unit(orks, 'Gunwagon').wargear?.[0];
      if (!zzap) throw new Error('orks: Gunwagon has no wargear');
      zzap.points += 5;
      return fs;
    },
  },
  {
    // Pricing schemes changing: tiers added (one unit, and one across the Space Marines
    // family), tiers collapsing back to one, and a tier's heading reworded.
    name: 're-tiered',
    scrape: (fs) => {
      const necrons = faction(fs, 'necrons');
      necrons.firstSeen = '2026-10-20';
      addThirdPlusTier(unit(necrons, 'Immortals'), 10);
      const wraiths = unit(necrons, 'Canoptek Wraiths');
      const [first] = wraiths.pricing;
      if (!first) throw new Error('necrons: Canoptek Wraiths has no pricing');
      wraiths.pricing = [{ ...first, range: '[1,)', label: 'Your Unit Costs' }];
      for (const f of spaceMarines(fs)) {
        f.firstSeen = '2026-10-20';
        addThirdPlusTier(unit(f, 'Intercessor Squad'), 10);
      }
      const orks = faction(fs, 'orks');
      orks.firstSeen = '2026-10-20';
      const third = unit(orks, 'Gunwagon').pricing[1];
      if (!third) throw new Error('orks: Gunwagon has one tier');
      third.label = 'Your 3rd+ Units Cost';
      return fs;
    },
  },
  {
    // A new MFM revision: every faction bumped, a new faction, the Muster Armies rules
    // changed, and one reprice. The factions are stamped the 21st; the rules change has no
    // stamp, so it dates the update's last day as today.
    name: 'revision',
    datedToday: true,
    scrape: (fs, meta) => {
      for (const f of fs) Object.assign(f, { version: '1.7', firstSeen: '2026-10-21' });
      reprice(unit(faction(fs, 'orks'), 'Nobz'), 10);
      const newcomer: Faction = {
        ...structuredClone(faction(fs, 'chaos-titan-legions')),
        slug: 'questor-traitoris',
        name: 'Questor Traitoris',
      };
      const lines = (meta.muster ?? '').split('\n');
      const at = lines.findIndex((l) => l.startsWith('| STRIKE FORCE'));
      if (at === -1) throw new Error('meta.yaml: no Strike Force row in Muster Armies');
      lines[at] =
        '| STRIKE FORCE | 2000         | 4                      | 4                 | 3            |';
      lines.splice(
        at + 1,
        0,
        '| ONSLAUGHT    | 3000         | 5                      | 6                 | 4            |',
      );
      Object.assign(meta, {
        version: '1.7',
        lastUpdated: '2026-10-21',
        muster: lines.join('\n'),
        factions: [...meta.factions, newcomer.slug],
      });
      return [...fs, newcomer];
    },
  },
  {
    // Only the "Welcome…" notes changed: no faction to date it by.
    name: 'rules-only',
    datedToday: true,
    scrape: (fs, meta) => {
      meta.notes = (meta.notes ?? '').replace(
        'marked with red or green',
        'marked with red or green (red raised, green lowered)',
      );
      return fs;
    },
  },
  {
    // A faction page that disappeared: removals carry no stamp, so they date as today.
    name: 'withdrawn',
    datedToday: true,
    scrape: (fs, meta) => {
      meta.factions = meta.factions.filter((s) => s !== 'chaos-titan-legions');
      return fs.filter((f) => f.slug !== 'chaos-titan-legions');
    },
  },
  {
    // Every cost outside the Space Marines family moved: past GitHub's PR body limit, so
    // the body is shortened, largest sections first. The changelog entry stays whole.
    name: 'oversized',
    scrape: (fs) => {
      const family = new Set(spaceMarines(fs));
      for (const f of fs.filter((x) => !family.has(x))) {
        f.firstSeen = '2026-10-30';
        for (const u of f.units) for (const t of u.pricing) for (const c of t.costs) c.points += 5;
      }
      return fs;
    },
  },
];

// ---- Writing it out, as the workflow has it on disk ------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'mfm-golden-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The scraped side of a case, written as the scraper writes `data/`. */
function scrapedDir(c: Case): string {
  const dir = join(scratch, c.name, 'data');
  mkdirSync(dir, { recursive: true });
  const meta = structuredClone(beforeMeta) as SiteMeta;
  for (const f of c.scrape(structuredClone(before), meta))
    writeFileSync(join(dir, `${f.slug}.yaml`), factionToYaml(f));
  writeFileSync(join(dir, 'meta.yaml'), metaToYaml(meta));
  return dir;
}

const golden = (c: Case, file: string) => `./golden/${c.name}/${file}`;
const readGolden = (c: Case, file: string) =>
  readFileSync(fileURLToPath(new URL(golden(c, file), import.meta.url)), 'utf8');

// ---- The update-PR plan ----------------------------------------------------------

const pr = (number: number, headRefName: string, baseRefName: string): UpdatePr => ({
  number,
  headRefName,
  baseRefName,
});

/** The open PRs the plan is made against, as `mfm open-prs` lists them. */
const OPEN: [string, UpdatePr[]][] = [
  ['no update PR open', []],
  [
    'v1.6 open on main, beside a Dependabot PR',
    [pr(78, 'mfm/v1.6', 'main'), pr(59, 'dependabot/npm_and_yarn/npm-minor-patch-c9', 'main')],
  ],
  ['v1.5 open, v1.6 stacked on it', [pr(63, 'mfm/v1.5', 'main'), pr(64, 'mfm/v1.6', 'mfm/v1.5')]],
  ['two update PRs on main', [pr(63, 'mfm/v1.5', 'main'), pr(70, 'mfm/v1.7', 'main')]],
];

/** One plan as the workflow's step outputs, or the error that stops the run. */
function planBlock(prs: UpdatePr[], version: string): string {
  try {
    const plan = planUpdate(prs, version);
    return `branch=${plan.branch}\nbase=${plan.base}\nbelow=${plan.below.join(' ')}\n`;
  } catch (err) {
    return `error: ${(err as Error).message}\n`;
  }
}

const planFile = (version: string) =>
  OPEN.map(([label, prs]) => `## ${label}\n${planBlock(prs, version)}`).join('\n');

// ---- The tests ---------------------------------------------------------------------

describe.each(CASES)('golden: $name', (c) => {
  const dir = scrapedDir(c);
  const after = loadFactionDir(dir);
  const afterMeta = loadMeta(dir);
  const opts = { today: TODAY, meta: { before: beforeMeta, after: afterMeta } };
  const version = afterMeta?.version ?? '';

  it('PR title and body', async () => {
    await expect(`${updateTitle(before, after, opts)}\n`).toMatchFileSnapshot(
      golden(c, 'title.txt'),
    );
    await expect(changelog(before, after, opts)).toMatchFileSnapshot(golden(c, 'pr-body.md'));
  });

  it('changelog entry', async () => {
    await expect(changelogEntry(before, after, opts)).toMatchFileSnapshot(
      golden(c, 'changelog-entry.md'),
    );
  });

  it('Discord payload', async () => {
    const message = announcement(before, after, { ...opts, ...PR });
    await expect(`${JSON.stringify(message, null, 2)}\n`).toMatchFileSnapshot(
      golden(c, 'announcement.json'),
    );
  });

  it('update-PR plan', async () => {
    await expect(planFile(version)).toMatchFileSnapshot(golden(c, 'plan.txt'));
  });

  // The same outputs from the commands the workflow runs. Today-dated cases are left to
  // the function checks above: the commands take no `--today`.
  it.skipIf(c.datedToday)('the workflow commands print the same', async () => {
    const out = join(scratch, c.name);
    const outputs = join(out, 'outputs.txt');
    const diff = await mfm([
      'diff',
      DATA,
      dir,
      '--body-file',
      join(out, 'body.md'),
      '--output',
      outputs,
    ]);
    expect(diff.stdout).toBe(readGolden(c, 'pr-body.md'));
    expect(readFileSync(join(out, 'body.md'), 'utf8')).toBe(readGolden(c, 'pr-body.md'));
    // An update with nothing in it is dated today, and never published.
    if (c.name !== 'unchanged')
      expect(readFileSync(outputs, 'utf8')).toBe(`title=${readGolden(c, 'title.txt')}`);

    const discord = await mfm(['announce', DATA, dir, '--pr-number', '78', '--pr-url', PR.prUrl]);
    const payload = JSON.parse(readGolden(c, 'announcement.json'));
    if (payload === null) {
      expect(discord.stdout).toBe('');
      expect(discord.stderr).toBe('No data changes — nothing to announce.\n');
    } else expect(discord.stdout).toBe(`${JSON.stringify(payload)}\n`);

    for (const [i, [, prs]] of OPEN.entries()) {
      const file = join(out, `prs-${i}.json`);
      writeFileSync(file, JSON.stringify(prs));
      const want = planBlock(prs, version);
      if (want.startsWith('error: ')) {
        await expect(mfm(['plan', file, dir])).rejects.toThrow(want.slice('error: '.length).trim());
      } else expect((await mfm(['plan', file, dir])).stdout).toBe(want);
    }

    const root = join(out, 'pub');
    const entry = await mfm(['changelog', DATA, dir, '--root', root]);
    const wanted = readGolden(c, 'changelog-entry.md');
    if (wanted === '') {
      expect(entry.stdout).toBe(
        'No data changes — changelog and DATA-CHANGELOG.md left untouched.\n',
      );
      expect(existsSync(join(root, 'changelog'))).toBe(false);
    } else {
      const file = readFileSync(join(root, 'changelog', `v${version}.md`), 'utf8');
      expect(file).toContain(`<!-- BEGIN ENTRIES -->\n\n${wanted}`);
      // The files around the entry, once: they don't vary with the change set.
      if (c.name === 'repriced') {
        await expect(file).toMatchFileSnapshot(golden(c, 'changelog-file.md'));
        await expect(readFileSync(join(root, 'DATA-CHANGELOG.md'), 'utf8')).toMatchFileSnapshot(
          golden(c, 'DATA-CHANGELOG.md'),
        );
      }
    }
  });

  // And once as the workflow starts it: a separate process, through tsx.
  it.runIf(c.name === 'repriced')('runs as a command', { timeout: 60_000 }, async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', TSX, join(ROOT, 'src', 'bin', 'mfm.ts'), 'diff', DATA, dir],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
    );
    expect(stdout).toBe(readGolden(c, 'pr-body.md'));
  });
});

// ---- Running the commands ----------------------------------------------------------

const TSX = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

/** Run `mfm` in-process, collecting what it prints. */
async function mfm(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
