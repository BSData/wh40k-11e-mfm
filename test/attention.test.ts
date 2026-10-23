import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FACTOR, MAX_LISTED, valueNote } from '../src/diff/attention.js';
import {
  attentionSection,
  changelog,
  changelogEntry,
  type Flag,
  loadFactionDir,
  loadMeta,
  needsAttention,
} from '../src/diff.js';
import { announcement } from '../src/discord.js';
import type { SiteMeta } from '../src/emit.js';
import type { Faction, Unit } from '../src/model.js';

/**
 * The "Needs attention" flags (src/diff/attention.ts): each rule at its threshold, how
 * they are listed, and that no real update so far trips any of them. The real updates are
 * the datasets frozen under test/golden/ (data-v1.3 to data-v1.6), each the `data/` the
 * repository had when that MFM version's update PRs had merged.
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
    expect(out.at(-1)).toBe('> - …and 3 more');
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
    expect(changelogEntry(base, after, { meta, today: '2026-10-23' })).not.toContain(
      'Needs attention',
    );
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

  // Every real update so far. The largest moves in them are a faction losing 39% of its
  // units, a value changing ×2.5 and a re-tiered price ×1.82 (docs/decisions/0026).
  it.each([
    ['1.3', '1.4'],
    ['1.4', '1.5'],
    ['1.5', '1.6'],
  ])('on the real v%s → v%s update', (from, to) => {
    const [b, a] = [golden(from), golden(to)];
    const flags = needsAttention(loadFactionDir(b), loadFactionDir(a), {
      meta: { before: loadMeta(b), after: loadMeta(a) },
    });
    expect(flags).toEqual([]);
  });
});
