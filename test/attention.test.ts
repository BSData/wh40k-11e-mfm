import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/bin/mfm.js';
import { FACTOR, MAX_LISTED, valueNote } from '../src/diff/attention.js';
import {
  attentionSection,
  changelog,
  changelogEntry,
  collectAttention,
  collectChanges,
  type Flag,
  loadFactionDir,
  loadMeta,
  needsAttention,
} from '../src/diff.js';
import { announcement } from '../src/discord.js';
import { metaToYaml, type SiteMeta } from '../src/emit.js';
import type { CostOption, Faction, Unit } from '../src/model.js';
import { BRIEF_MARKER } from '../src/ops/brief.js';

/**
 * The "Needs attention" flags (src/diff/attention.ts): each rule at its threshold, how
 * they are listed, and that no real update so far trips any of them. The real updates are
 * replayed from `data/` as it was in git history, frozen byte for byte under test/golden/:
 *  - data-v1.3: main just before the v1.4 update (#42);
 *  - data-v1.4: after #42;
 *  - data-v1.5-pr53 and data-v1.5: after the two v1.5 updates, #53 and #63;
 *  - data-v1.6 and data-v1.6-pr78: after the two v1.6 updates, #64 and #78.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const golden = (version: string) => join(ROOT, 'test', 'golden', `data-v${version}`);
const V16 = golden('1.6');
const base = loadFactionDir(V16);
const baseMeta = loadMeta(V16) as SiteMeta;

/** A copy of the v1.6 snapshot, changed by `edit`, against the original. */
function flagsFor(edit: (fs: Faction[], meta: SiteMeta) => Faction[] | undefined): Flag[] {
  const after = structuredClone(base);
  const meta = structuredClone(baseMeta);
  const scraped = edit(after, meta) ?? after;
  return needsAttention(base, scraped, { meta: { before: baseMeta, after: meta } });
}

const faction = (fs: Faction[], slug: string): Faction => {
  const f = fs.find((x) => x.slug === slug);
  if (!f) throw new Error(`no faction ${slug}`);
  return f;
};
const unit = (f: Faction, name: string): Unit => {
  const u = f.units.find((x) => x.name === name);
  if (!u) throw new Error(`${f.slug}: no unit ${name}`);
  return u;
};
/** Set the first cost option of a unit's first tier. */
const setCost = (u: Unit, points: number) => {
  const cost = u.pricing[0]?.costs[0];
  if (!cost) throw new Error(`${u.name}: no cost`);
  cost.points = points;
};
const lines = (flags: Flag[]) => attentionSection(flags).split('\n');

describe('valueNote', () => {
  it.each([
    [85, 255, '×3'],
    [85, 300, '×3.5'],
    [90, 30, '÷3'],
    [100, 25, '÷4'],
    [85, 0, 'to 0'],
    [0, 20, 'up from 0'],
  ])('%i → %i needs attention (%s)', (from, to, note) => {
    expect(valueNote(from, to)?.note).toBe(note);
  });

  it.each([
    [85, 254],
    [90, 31],
    [10, 25],
    [85, 85],
    [0, 0],
  ])('%i → %i does not', (from, to) => {
    expect(valueNote(from, to)).toBeUndefined();
  });

  it('flags at the factor the spec names', () => {
    expect(FACTOR).toBe(3);
  });
});

describe('the rules', () => {
  it('nothing needs attention when nothing changed', () => {
    expect(flagsFor(() => undefined)).toEqual([]);
  });

  it('a faction that is gone', () => {
    const flags = flagsFor((fs) => fs.filter((f) => f.slug !== 'necrons'));
    const necrons = faction(base, 'necrons');
    expect(flags).toEqual([
      {
        kind: 'gone',
        factions: ['Necrons'],
        what: `is gone from the site (it had ${necrons.units.length} units and ${necrons.detachments.length} detachments)`,
      },
    ]);
  });

  it('a faction the index stopped listing, whose file the snapshot keeps', () => {
    const flags = flagsFor((fs, meta) => {
      meta.factions = meta.factions.filter((s) => s !== 'chaos-titan-legions');
      return fs;
    });
    expect(flags).toEqual([
      {
        kind: 'gone',
        factions: ['Chaos Titan Legions'],
        what: "is gone from the site's index (it had 4 units; its `data/` file is kept as it was)",
      },
    ]);
  });

  it('a slug meta.yaml listed with no faction file, by its slug', () => {
    const before = { ...baseMeta, factions: [...baseMeta.factions, 'squats'] };
    expect(needsAttention(base, base, { meta: { before, after: baseMeta } })).toEqual([
      {
        kind: 'gone',
        factions: ['`squats`'],
        what: "is gone from the site's index (`meta.yaml` listed it, but it had no `data/` file)",
      },
    ]);
  });

  it('a faction whose file is gone and the index too, once', () => {
    const flags = flagsFor((fs, meta) => {
      meta.factions = meta.factions.filter((s) => s !== 'necrons');
      return fs.filter((f) => f.slug !== 'necrons');
    });
    expect(flags.map((f) => [f.kind, f.factions])).toEqual([['gone', ['Necrons']]]);
  });

  it('a faction that lost more than half its units, not half', () => {
    const had = faction(base, 'necrons').units.length;
    const keep = (n: number) =>
      flagsFor((fs) => {
        const f = faction(fs, 'necrons');
        f.units = f.units.slice(0, n);
        return fs;
      }).filter((x) => x.kind === 'units-lost');
    expect(keep(Math.ceil(had / 2))).toEqual([]);
    expect(keep(Math.ceil(had / 2) - 1)).toEqual([
      {
        kind: 'units-lost',
        factions: ['Necrons'],
        what: `lost ${had - (Math.ceil(had / 2) - 1)} of its ${had} units`,
      },
    ]);
  });

  it('counts a mass rename as units lost, and says what took their place', () => {
    const flags = flagsFor((fs) => {
      const f = faction(fs, 'necrons');
      for (const u of f.units) u.name = `${u.name} (misread)`;
      return fs;
    });
    const had = faction(base, 'necrons').units.length;
    expect(flags.map((f) => f.what)).toContain(
      `lost ${had} of its ${had} units (and gained ${had})`,
    );
  });

  it('a cost that dropped to 0, or changed threefold either way', () => {
    const flags = flagsFor((fs) => {
      const necrons = faction(fs, 'necrons');
      setCost(unit(necrons, 'Necron Warriors'), 0); // 85 → 0
      setCost(unit(necrons, 'Nekrosor Ammentar'), 195 * 3); // ×3
      return fs;
    });
    expect(flags.map((f) => [f.kind, f.what])).toEqual([
      ['to-zero', 'Necron Warriors — 10 models: 85 → 0 (to 0)'],
      ['threefold', 'Nekrosor Ammentar — 1 model: 195 → 585 (×3)'],
    ]);
  });

  it('a wargear item or an enhancement too', () => {
    const flags = flagsFor((fs) => {
      const orks = faction(fs, 'orks');
      const zzap = unit(orks, 'Gunwagon').wargear?.[0];
      if (!zzap) throw new Error('orks: Gunwagon has no wargear');
      zzap.points *= 4;
      const enh = faction(fs, 'necrons').detachments[0]?.enhancements[0];
      if (!enh) throw new Error('necrons: no enhancement');
      enh.points = 0;
      return fs;
    });
    expect(flags.map((f) => f.kind).sort()).toEqual(['threefold', 'to-zero']);
    expect(flags.find((f) => f.kind === 'threefold')?.what).toMatch(
      /^Gunwagon — Zzap Gun: \d+ → \d+ \(×4\)$/,
    );
  });

  it('not a routine reprice', () => {
    const flags = flagsFor((fs) => {
      for (const f of fs)
        for (const u of f.units) for (const c of u.pricing[0]?.costs ?? []) c.points += 10;
      return fs;
    });
    expect(flags).toEqual([]);
  });

  it('a re-tiered unit: a new price threefold its old range, but not a routine new tier', () => {
    const retier = (third: (p: number) => number) =>
      flagsFor((fs) => {
        const u = unit(faction(fs, 'necrons'), 'Necron Warriors');
        const [only] = u.pricing;
        if (!only) throw new Error('no tier');
        u.pricing = [
          { ...only, range: '[1,2]', label: 'Your 1st To 2nd Units Cost' },
          {
            range: '[3,)',
            label: 'Your 3rd + Unit Costs',
            costs: only.costs.map((c) => ({ ...c, points: third(c.points) })),
          },
        ];
        return fs;
      });
    expect(retier((p) => p + 15)).toEqual([]);
    expect(retier((p) => p * 3).map((f) => f.what)).toEqual([
      'Necron Warriors — 10 models: 85 → 85 / 255 (re-tiered, ×3)',
      'Necron Warriors — 20 models: 190 → 190 / 570 (re-tiered, ×3)',
    ]);
    // Either side of the threshold, both ways: 254 and 569 are under ×3; 30 and 65 are
    // above a third (28.3 and 63.3); 28 and 63 are at a third or less.
    expect(retier((p) => p * 3 - 1)).toEqual([]);
    expect(retier((p) => Math.ceil(p / 3) + 1)).toEqual([]);
    expect(retier((p) => Math.floor(p / 3)).map((f) => f.what)).toEqual([
      'Necron Warriors — 10 models: 85 → 85 / 28 (re-tiered, ÷3)',
      'Necron Warriors — 20 models: 190 → 190 / 63 (re-tiered, ÷3)',
    ]);
    expect(retier(() => 0).map((f) => f.kind)).toEqual(['to-zero', 'to-zero']);
  });

  // Necron Warriors in v1.6 has one tier, `10 models: 85` and `20 models: 190`: 8.5 and
  // 9.5 points a model.
  const warriors = (fs: Faction[]) => unit(faction(fs, 'necrons'), 'Necron Warriors');
  const withRow = (row: CostOption) =>
    flagsFor((fs) => {
      warriors(fs).pricing[0]?.costs.push(row);
      return fs;
    });

  it('a new cost row priced off its unit, per model', () => {
    // A misread model count with a tenfold price: 10 models at 85 read as 1 model at 850.
    const flags = flagsFor((fs) => {
      const tier = warriors(fs).pricing[0];
      if (!tier) throw new Error('no tier');
      tier.costs[0] = { models: 1, points: 850 };
      return fs;
    });
    expect(flags).toEqual([
      {
        kind: 'threefold',
        factions: ['Necrons'],
        what: 'Necron Warriors — 1 model: new at 850 (×89.5 per model)',
      },
    ]);
    // Either side of ×3 against the most, 9.5 a model, and of a third of the least, 8.5.
    // (Model counts the unit doesn't have, so each row is new rather than a reprice.)
    expect(withRow({ models: 15, points: 140 })).toEqual([]);
    expect(withRow({ models: 1, points: 28 })).toEqual([]);
    expect(withRow({ models: 1, points: 29 }).map((f) => f.what)).toEqual([
      'Necron Warriors — 1 model: new at 29 (×3.1 per model)',
    ]);
    expect(withRow({ models: 30, points: 87 })).toEqual([]);
    expect(withRow({ models: 30, points: 84 }).map((f) => f.what)).toEqual([
      'Necron Warriors — 30 models: new at 84 (÷3 per model)',
    ]);
    expect(withRow({ models: 5, points: 0 }).map((f) => [f.kind, f.what])).toEqual([
      ['to-zero', 'Necron Warriors — 5 models: new at 0'],
    ]);
    // An add-on prices an extra, not models: not measured.
    expect(withRow({ models: 1, points: 500, desc: 'Big Gun', addon: true })).toEqual([]);
  });

  it('a new cost row names its tier, where the unit has more than one', () => {
    // Doomsday Ark: `1 model` at 200 (1st–2nd) and 230 (3rd+).
    const flags = flagsFor((fs) => {
      const ark = unit(faction(fs, 'necrons'), 'Doomsday Ark');
      ark.pricing[1]?.costs.push({ models: 2, points: 2000 });
      return fs;
    });
    expect(flags.map((f) => f.what)).toEqual([
      'Doomsday Ark — 2 models (3rd+): new at 2000 (×4.3 per model)',
    ]);
  });

  it('an option new in a re-tier, per model', () => {
    const retier = (extra: CostOption) =>
      flagsFor((fs) => {
        const u = warriors(fs);
        const [only] = u.pricing;
        if (!only) throw new Error('no tier');
        u.pricing = [
          { ...only, range: '[1,2]', label: 'Your 1st To 2nd Units Cost' },
          {
            range: '[3,)',
            label: 'Your 3rd + Unit Costs',
            costs: [...only.costs.map((c) => ({ ...c, points: c.points + 15 })), extra],
          },
        ];
        return fs;
      });
    expect(retier({ models: 1, points: 850 }).map((f) => f.what)).toEqual([
      'Necron Warriors — 1 model: — → 850 (re-tiered, new option, ×89.5 per model)',
    ]);
    expect(retier({ models: 1, points: 10 })).toEqual([]);
  });

  it('not a removed row: its misread, if any, is the new row beside it', () => {
    expect(
      flagsFor((fs) => {
        warriors(fs).pricing[0]?.costs.pop();
        return fs;
      }),
    ).toEqual([]);
  });

  it('a new version with nothing else in it, but not one that changed anything', () => {
    const bump = (also: (fs: Faction[]) => void) =>
      flagsFor((fs, meta) => {
        for (const f of fs) f.version = '1.7';
        meta.version = '1.7';
        also(fs);
        return fs;
      });
    expect(bump(() => {})).toEqual([
      {
        kind: 'version-only',
        factions: [],
        what: 'Only the version changed (v1.6 → v1.7): no points, units, detachments or rules moved, so the scraper may be missing what the new version changed',
      },
    ]);
    expect(bump((fs) => setCost(unit(faction(fs, 'orks'), 'Nobz'), 120))).toEqual([]);
  });

  it('a new site version and nothing else, with no faction changed at all', () => {
    const flags = flagsFor((fs, meta) => {
      meta.version = '1.7';
      return fs;
    });
    expect(flags.map((f) => [f.kind, f.what.split(':')[0]])).toEqual([
      ['version-only', 'Only the version changed (v1.6 → v1.7)'],
    ]);
  });

  it('a version-only update without meta.yaml: every faction, or just one', () => {
    const bumped = (which: (f: Faction) => boolean) => {
      const after = structuredClone(base);
      for (const f of after.filter(which)) f.version = '1.7';
      return needsAttention(base, after).map((f) => [f.kind, f.what.split(':')[0]]);
    };
    const want = [['version-only', 'Only the version changed (v1.6 → v1.7)']];
    expect(bumped(() => true)).toEqual(want);
    expect(bumped((f) => f.slug === 'orks')).toEqual(want);
  });

  it("a version-only update whose rules diff carries no site version ('')", () => {
    const after = structuredClone(base);
    for (const f of after) f.version = '1.7';
    const rules = { schema: '', version: '', panels: [] };
    const flags = collectAttention(collectChanges(base, after), rules, base, after);
    expect(flags.map((f) => [f.kind, f.what.split(':')[0]])).toEqual([
      ['version-only', 'Only the version changed (v1.6 → v1.7)'],
    ]);
  });

  it('a rules panel change is not version-only either', () => {
    const flags = flagsFor((fs, meta) => {
      meta.version = '1.7';
      meta.notes = `${meta.notes ?? ''}\nA new line.`;
      return fs;
    });
    expect(flags).toEqual([]);
  });

  it('one line for a flag a family shares word for word', () => {
    const flags = flagsFor((fs) => {
      for (const f of fs.filter((x) => x.slug === 'space-marines' || x.parent === 'Space Marines'))
        setCost(unit(f, 'Intercessor Squad'), 0);
      return fs;
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.factions).toEqual([
      'Black Templars',
      'Blood Angels',
      'Dark Angels',
      'Deathwatch',
      'Space Marines',
      'Space Wolves',
    ]);
  });
});

describe('the warning', () => {
  it('is nothing without flags', () => {
    expect(attentionSection([])).toBe('');
  });

  it('is a GitHub alert, the factions in bold', () => {
    const flags: Flag[] = [
      {
        kind: 'gone',
        factions: ['Necrons'],
        what: 'is gone from the site (it had 2 units and 1 detachment)',
      },
      { kind: 'to-zero', factions: ['Orks', 'Necrons'], what: 'X — 1 model: 5 → 0 (to 0)' },
    ];
    expect(attentionSection(flags)).toBe(
      [
        '> [!WARNING]',
        '> **Needs attention:** 2 changes that look more like the scraper misreading the site than GW changing it. Check them against the site before merging.',
        '>',
        '> - **Necrons** is gone from the site (it had 2 units and 1 detachment)',
        '> - **Orks** and **Necrons**: X — 1 model: 5 → 0 (to 0)',
      ].join('\n'),
    );
  });

  it(`lists at most ${MAX_LISTED}, and counts the rest`, () => {
    const many: Flag[] = Array.from({ length: MAX_LISTED + 3 }, (_, i) => ({
      kind: 'threefold',
      factions: ['Orks'],
      what: `Unit ${i}`,
    }));
    const out = lines(many);
    expect(out.filter((l) => l.startsWith('> - **Orks**'))).toHaveLength(MAX_LISTED);
    expect(out.at(-1)).toBe('> - …and 3 more, which `mfm attention` lists');
  });

  it('opens the PR body, straight after the title, and stays out of the changelog file', () => {
    const after = base.filter((f) => f.slug !== 'necrons');
    const meta = {
      before: baseMeta,
      after: { ...baseMeta, factions: baseMeta.factions.filter((s) => s !== 'necrons') },
    };
    const body = changelog(base, after, { meta, today: '2026-10-23' }).split('\n');
    expect(body[0]).toMatch(/^# MFM v1\.6 update/);
    expect(body[1]).toBe('');
    expect(body[2]).toBe('> [!WARNING]');
    // The warning, a blank line, the mark, a blank line, the blurb.
    const mark = body.indexOf(BRIEF_MARKER);
    expect(body.slice(2, mark - 1).every((l) => l.startsWith('>'))).toBe(true);
    expect(body[mark - 1]).toBe('');
    expect(body[mark + 2]).toMatch(/^_Automated/);
    expect(changelogEntry(base, after, { meta, today: '2026-10-23' })).not.toContain(
      'Needs attention',
    );
  });

  it('makes a PR body on its own, when no data file changed', () => {
    const meta = {
      before: baseMeta,
      after: { ...baseMeta, factions: baseMeta.factions.filter((s) => s !== 'necrons') },
    };
    const body = changelog(base, base, { meta, today: '2026-10-23' });
    expect(body).toContain("> - **Necrons** is gone from the site's index");
    expect(body).not.toContain(BRIEF_MARKER);
    // `mfm changelog` writes no entry for it, so the blurb names none.
    expect(changelogEntry(base, base, { meta, today: '2026-10-23' })).toBe('');
    expect(body).not.toContain('changelog/');
    expect(body).toContain('this PR commits no changelog entry');
    expect(changelog(base, base, { meta: { before: baseMeta, after: baseMeta } })).toBe(
      'No changes detected.\n',
    );
  });

  it('is announced on its own too, when no data file changed', () => {
    const meta = {
      before: baseMeta,
      after: { ...baseMeta, factions: baseMeta.factions.filter((s) => s !== 'necrons') },
    };
    const message = announcement(base, base, { meta, today: '2026-10-23' });
    expect(message?.embeds[0]?.description.split('\n').slice(0, 2)).toEqual([
      '⚠️ **1 change needs attention** — check it on the PR before relying on this update',
      '**No faction changes**',
    ]);
    expect(announcement(base, base, { meta: { before: baseMeta, after: baseMeta } })).toBeNull();
  });

  it('is counted at the top of the Discord summary', () => {
    const after = base.filter((f) => f.slug !== 'necrons');
    const message = announcement(base, after, { today: '2026-10-23' });
    expect(message?.embeds[0]?.description.split('\n')[0]).toBe(
      '⚠️ **1 change needs attention** — check it on the PR before relying on this update',
    );
  });
});

describe('no false alarms', () => {
  it("on today's data/ against itself", () => {
    const data = join(ROOT, 'data');
    const meta = loadMeta(data);
    expect(
      needsAttention(loadFactionDir(data), loadFactionDir(data), {
        meta: { before: meta, after: meta },
      }),
    ).toEqual([]);
  });

  // Every real update so far, one by one. The largest moves in them are a faction losing
  // 39% of its units, a value changing ×2.5 and a re-tiered price ×1.82
  // (docs/decisions/0027).
  it.each([
    ['1.3', '1.4', '#42'],
    ['1.4', '1.5-pr53', '#53'],
    ['1.5-pr53', '1.5', '#63'],
    ['1.5', '1.6', '#64'],
    ['1.6', '1.6-pr78', '#78'],
  ])('on the real update from v%s to v%s (%s)', (from, to) => {
    const [b, a] = [golden(from), golden(to)];
    const flags = needsAttention(loadFactionDir(b), loadFactionDir(a), {
      meta: { before: loadMeta(b), after: loadMeta(a) },
    });
    expect(flags).toEqual([]);
  });
});

describe('mfm attention', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'mfm-attention-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let server: Server | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise((done) => server?.close(done));
    server = undefined;
  });

  /** The v1.6 snapshot with Chaos Titan Legions gone from the index, its file kept. */
  const withdrawn = () => {
    const dir = join(scratch, 'withdrawn');
    cpSync(V16, dir, { recursive: true });
    const factions = baseMeta.factions.filter((s) => s !== 'chaos-titan-legions');
    writeFileSync(join(dir, 'meta.yaml'), metaToYaml({ ...baseMeta, factions }));
    return dir;
  };

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

  it('prints one line per flag, and nothing when there are none', async () => {
    expect((await mfm('attention', V16, withdrawn())).stdout).toBe(
      "- **Chaos Titan Legions** is gone from the site's index (it had 4 units; its `data/` file is kept as it was)\n",
    );
    expect(await mfm('attention', V16, V16)).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('--label labels the PR through the API', async () => {
    const calls: string[] = [];
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        calls.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
      });
    });
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    vi.stubEnv('GITHUB_API_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    vi.stubEnv('GITHUB_REPOSITORY', 'BSData/wh40k-11e-mfm');
    vi.stubEnv('GH_TOKEN', 't0ken');
    const { code, stderr } = await mfm(
      'attention',
      V16,
      withdrawn(),
      '--label',
      '--pr-number',
      '96',
    );
    expect(code).toBe(0);
    expect(stderr).toBe('needs-attention on #96: added.\n');
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([
      'POST /repos/BSData/wh40k-11e-mfm/labels',
      'POST /repos/BSData/wh40k-11e-mfm/issues/96/labels',
    ]);
  });
});
