import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  changelog,
  changelogEntry,
  failuresReport,
  updateTitle,
  updateWindow,
  windowLabel,
} from '../src/diff.js';
import { factionFromYaml, factionToYaml, metaFromYaml, metaToYaml } from '../src/emit.js';
import type { Faction, FactionContent } from '../src/model.js';
import { parseFaction } from '../src/parse.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

// Parsed once — the fixture is large and most tests want a fresh, mutable copy.
const parsedNecrons = parseFaction(fixture('necrons.html'), 'necrons', 'Necrons');
const necronsContent = (): FactionContent => structuredClone(parsedNecrons);
const necrons = (firstSeen = '2026-06-17'): Faction => ({ ...necronsContent(), firstSeen });

describe('emit', () => {
  it('round-trips a faction through YAML losslessly', () => {
    const yaml = factionToYaml(necrons());
    // emit → parse → emit is stable, and no data is lost on the way back.
    expect(factionToYaml(factionFromYaml(yaml))).toBe(yaml);
    const back = factionFromYaml(yaml);
    expect(back.units).toHaveLength(52);
    expect(back.firstSeen).toBe('2026-06-17');
  });

  it('is deterministic — same input yields byte-identical YAML', () => {
    expect(factionToYaml(necrons())).toBe(factionToYaml(necrons()));
  });

  it('orders entities alphabetically by default and by source order with --order page', () => {
    const sourceOrder = necronsContent().units.map((u) => u.name);
    const unitNames = (yaml: string) =>
      (parseYaml(yaml).units as { name: string }[]).map((u) => u.name);

    // 'page' keeps the parsed (source) order; 'name' (default) sorts alphabetically.
    expect(unitNames(factionToYaml(necrons(), 'page'))).toEqual(sourceOrder);
    expect(unitNames(factionToYaml(necrons()))).toEqual(
      [...sourceOrder].sort((a, b) => a.localeCompare(b)),
    );
    // The two modes genuinely differ for this faction (guards against a no-op test).
    expect(unitNames(factionToYaml(necrons(), 'page'))).not.toEqual(
      unitNames(factionToYaml(necrons(), 'name')),
    );
  });

  it('quotes the version and includes firstSeen', () => {
    const yaml = factionToYaml(necrons('2026-06-17'));
    expect(yaml).toContain('version: "1.1"');
    expect(yaml).toContain('firstSeen: 2026-06-17');
  });

  it('round-trips meta', () => {
    const meta = { version: '1.0', lastUpdated: '2026-06-17', factions: ['necrons'] };
    expect(metaFromYaml(metaToYaml(meta))).toEqual(meta);
  });
});

describe('changelog (ignores firstSeen)', () => {
  it('reports nothing when content is identical despite different firstSeen', () => {
    expect(changelog([necrons('2026-01-01')], [necrons('2026-06-17')])).toBe(
      'No changes detected.\n',
    );
  });

  it('reports a points change with a signed, magnitude-sorted delta', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const warriors = after.units.find((u) => u.name === 'Necron Warriors');
    const opt = warriors?.pricing[0]?.costs.find((c) => c.models === 10);
    if (opt) opt.points += 10;
    const log = changelog([before], [after]);
    expect(log).toContain('## Necrons');
    expect(log).toContain('**Unit points:**');
    expect(log).toContain('Necron Warriors — 10 models: 80 → 90 pts (**+10**)');
  });

  it('leads with a one-line summary of the totals', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const opt = after.units
      .find((u) => u.name === 'Necron Warriors')
      ?.pricing[0]?.costs.find((c) => c.models === 10);
    if (opt) opt.points += 10;
    const log = changelog([before], [after]);
    expect(log).toContain('**1 faction changed**');
    expect(log).toContain('1 point change (▲1 ▼0, net +10 pts)');
  });

  it('sorts the biggest swing first', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const w = after.units.find((u) => u.name === 'Necron Warriors');
    const c10 = w?.pricing[0]?.costs.find((c) => c.models === 10);
    const c20 = w?.pricing[0]?.costs.find((c) => c.models === 20);
    if (c10) c10.points += 5;
    if (c20) c20.points -= 40;
    const log = changelog([before], [after]);
    expect(log.indexOf('20 models')).toBeLessThan(log.indexOf('10 models'));
  });

  it('reports added and removed units', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    after.units = after.units.filter((u) => u.name !== 'Necron Warriors');
    after.units.push({
      name: 'Test Construct',
      pricing: [{ range: '[1,)', label: 'x', costs: [{ models: 1, points: 5 }] }],
    });
    const log = changelog([before], [after]);
    expect(log).toContain('**Units removed:** Necron Warriors');
    expect(log).toContain('**Units added:** Test Construct');
  });

  it('reports wargear and per-ability attach-list changes', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const tech = after.units.find((u) => u.name === 'Technomancer');
    if (tech) {
      // Gains a Leader list while keeping its Support one — the v1.4 Judiciar shape.
      tech.leaderTo = ['Immortals'];
      tech.supportTo = ['Canoptek Wraiths'];
      tech.wargear = [{ item: 'Test Rod', points: 15 }];
    }
    const tb = before.units.find((u) => u.name === 'Technomancer');
    if (tb) tb.wargear = [{ item: 'Test Rod', points: 10 }];
    const log = changelog([before], [after]);
    expect(log).toContain('Technomancer — Test Rod: 10 → 15 pts (**+5**)');
    expect(log).toContain('Technomancer — leaderTo: — → Immortals');
    expect(log).toContain('Technomancer — supportTo:');
  });

  it('reports detachment DP and objective changes', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const det = after.detachments.find((d) => d.name === 'Annihilation Legion');
    if (det) {
      det.dp = 3;
      det.objectives = ['NEW OBJECTIVE', 'SECOND DISPOSITION'];
    }
    const log = changelog([before], [after]);
    expect(log).toContain('Annihilation Legion — DP: 2 → 3');
    expect(log).toContain(
      'Annihilation Legion — objectives: PURGE THE FOE → NEW OBJECTIVE, SECOND DISPOSITION',
    );
  });

  it('reports a brand new and a removed faction', () => {
    expect(changelog([], [necronsContent()])).toContain('🆕 **New faction**');
    expect(changelog([necronsContent()], [])).toContain('🗑 **Removed faction**');
  });

  it('renders a per-faction table when several factions changed', () => {
    const a1 = structuredClone(necronsContent());
    const a2 = { ...structuredClone(necronsContent()), slug: 'orks', name: 'Orks' };
    const before = [necronsContent(), { ...necronsContent(), slug: 'orks', name: 'Orks' }];
    const o1 = a1.units[0]?.pricing[0]?.costs[0];
    const o2 = a2.units[0]?.pricing[0]?.costs[0];
    if (o1) o1.points += 5;
    if (o2) o2.points -= 5;
    const log = changelog(before, [a1, a2]);
    expect(log).toContain('| Faction | Units | Detachments | Points |');
    expect(log).toContain('**2 factions changed**');
  });

  it('reports a detachment unique change and enhancement leaderTo/supportTo changes', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const dyn = after.detachments.find((d) => d.name === 'Awakened Dynasty');
    if (dyn) dyn.unique = 'Hypercrypt';
    const murdermind = after.detachments
      .find((d) => d.name === 'Cursed Legion')
      ?.enhancements.find((e) => e.name === 'Murdermind');
    // Murdermind grants Support in v1.1; add a Leader grant and narrow the Support one.
    if (murdermind) {
      murdermind.leaderTo = ['Lokhust Destroyers'];
      murdermind.supportTo = ['Skorpekh Destroyers'];
    }
    const log = changelog([before], [after]);
    expect(log).toContain('Awakened Dynasty — unique: Dynasty → Hypercrypt');
    expect(log).toContain('Cursed Legion · Murdermind — leaderTo:');
    expect(log).toContain('Cursed Legion · Murdermind — supportTo:');
  });
});

describe('changelogEntry (Keep a Changelog block)', () => {
  it('is empty when nothing changed', () => {
    expect(changelogEntry([necronsContent()], [necronsContent()], { date: '2026-06-23' })).toBe('');
  });

  it('groups changes under Added / Changed / Removed with a dated, versioned heading', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    // Added: a new unit. Removed: an existing unit. Changed: a points value.
    after.units = after.units.filter((u) => u.name !== 'Annihilation Barge');
    after.units.push({
      name: 'Shiny New Lord',
      pricing: [{ range: '[1,)', label: 'x', costs: [{ models: 1, points: 120 }] }],
    });
    const opt = after.units
      .find((u) => u.name === 'Necron Warriors')
      ?.pricing[0]?.costs.find((c) => c.models === 10);
    if (opt) opt.points += 10;

    const entry = changelogEntry([before], [after], { date: '2026-06-23' });
    expect(entry).toContain('## [2026-06-23] — MFM v1.1');
    expect(entry).toContain('### Added\n- **Necrons**: new unit Shiny New Lord');
    expect(entry).toContain('### Changed');
    expect(entry).toContain('**Necrons**: Necron Warriors — 10 models: 80 → 90 pts (+10)');
    expect(entry).toContain('### Removed\n- **Necrons**: removed unit Annihilation Barge');
    // Added section comes before Changed, which comes before Removed.
    expect(entry.indexOf('### Added')).toBeLessThan(entry.indexOf('### Changed'));
    expect(entry.indexOf('### Changed')).toBeLessThan(entry.indexOf('### Removed'));
  });

  it('records a brand-new faction as a single Added line', () => {
    const entry = changelogEntry([], [necronsContent()], { date: '2026-06-23' });
    expect(entry).toContain('### Added');
    expect(entry).toContain('**Necrons**: new faction (52 units, 12 detachments)');
  });
});

describe('failuresReport', () => {
  it('renders each failed faction with its located error in a code block', () => {
    const md = failuresReport([
      { slug: 'necrons', error: 'Unconsumed content on "necrons": page-level: "SURPRISE"' },
      { slug: 'orks', error: 'Unit "Boyz" has no pricing tiers' },
    ]);
    expect(md).toContain('## 2 factions failed to parse');
    expect(md).toContain('### necrons');
    expect(md).toContain('Unconsumed content');
    expect(md).toContain('### orks');
    expect(md).toContain('```');
  });

  it('returns empty string when there are no failures', () => {
    expect(failuresReport([])).toBe('');
  });
});

/** Reprice the first Necron Warriors cost option, in place. */
const reprice = (f: FactionContent, by: number) => {
  const opt = f.units.find((u) => u.name === 'Necron Warriors')?.pricing[0]?.costs[0];
  if (opt) opt.points += by;
};

/** A second faction to diff against, so the summary renders its table. */
const asOrks = <T extends FactionContent>(f: T): T => ({
  ...structuredClone(f),
  slug: 'orks',
  name: 'Orks',
});

describe('update dates (the sticky PR keeps its start date)', () => {
  it('dates an update from the firstSeen stamps of the factions that changed', () => {
    const after = necrons('2026-08-31');
    reprice(after, 5);
    expect(updateTitle([necrons('2026-06-17')], [after])).toBe('MFM v1.1 update — 2026-08-31');
  });

  it('widens to a range when a later scrape adds to the still-open PR', () => {
    const before = [necrons('2026-06-17'), asOrks(necrons('2026-06-17'))];
    // The Necrons change was captured on the 31st and keeps that stamp; the Orks one
    // landed two days later, while the same PR was still open.
    const day1 = necrons('2026-08-31');
    reprice(day1, 5);
    const day3 = asOrks(necrons('2026-09-02'));
    reprice(day3, -5);
    expect(updateTitle(before, [day1, day3])).toBe('MFM v1.1 update — 2026-08-31 → 2026-09-02');
    expect(updateWindow(before, [day1, day3])).toEqual({
      from: '2026-08-31',
      to: '2026-09-02',
    });
  });

  it('ignores unchanged factions, however old their stamp', () => {
    const orks = asOrks(necrons('2026-01-01'));
    const after = necrons('2026-08-31');
    reprice(after, 5);
    expect(updateTitle([necrons('2026-06-17'), orks], [after, orks])).toBe(
      'MFM v1.1 update — 2026-08-31',
    );
  });

  it('falls back to today when the snapshots carry no stamps', () => {
    const after = necronsContent();
    reprice(after, 5);
    expect(updateTitle([necronsContent()], [after], { today: '2026-07-04' })).toBe(
      'MFM v1.1 update — 2026-07-04',
    );
  });

  it('heads the changelog and the DATA-CHANGELOG entry with the same window', () => {
    const after = necrons('2026-08-31');
    reprice(after, 5);
    expect(changelog([necrons('2026-06-17')], [after])).toContain('# MFM v1.1 update — 2026-08-31');
    expect(changelogEntry([necrons('2026-06-17')], [after])).toContain(
      '## [2026-08-31] — MFM v1.1',
    );
  });

  it('renders identically on a re-scrape that finds nothing new', () => {
    const after = necrons('2026-08-31');
    reprice(after, 5);
    const first = changelog([necrons('2026-06-17')], [after]);
    // Same data a day later: no re-stamping, so nothing in the body moves either.
    expect(changelog([necrons('2026-06-17')], [after], { today: '2026-09-01' })).toBe(first);
  });

  it('collapses a single-day window to one date', () => {
    expect(windowLabel({ from: '2026-08-31', to: '2026-08-31' })).toBe('2026-08-31');
    expect(windowLabel({ from: '2026-08-31', to: '2026-09-02' })).toBe('2026-08-31 → 2026-09-02');
  });
});

describe('summary table (stays in sync with the sections)', () => {
  const row = (log: string, name: string) =>
    log.split('\n').find((l) => l.startsWith(`| ${name} `)) ?? '';

  it('counts entities changed in place, not just whole ones added or removed', () => {
    const before = [necronsContent(), asOrks(necronsContent())];
    // Necrons: a cost option re-tiered (a row added and one removed, no delta at all).
    const retiered = necronsContent();
    const opt = retiered.units
      .find((u) => u.name === 'Necron Warriors')
      ?.pricing[0]?.costs.find((c) => c.models === 10);
    if (opt) opt.models = 11;
    // Orks: a detachment attribute edited, nothing repriced.
    const edited = asOrks(necronsContent());
    const det = edited.detachments[0];
    if (det) det.dp = 9;

    const log = changelog(before, [retiered, edited], { today: '2026-08-31' });
    // Both sections are non-empty, so neither row may read "—" across the board.
    expect(row(log, 'Necrons')).toBe('| Necrons | ~1 | — | — |');
    expect(row(log, 'Orks')).toBe('| Orks | — | ~1 | — |');
    expect(log).toContain('units ~1 · detachments ~1');
  });

  it('shows the net swing beside the ▲/▼ split', () => {
    const before = [necronsContent(), asOrks(necronsContent())];
    const up = necronsContent();
    reprice(up, 20);
    const down = asOrks(necronsContent());
    reprice(down, -5);
    const log = changelog(before, [up, down], { today: '2026-08-31' });
    expect(row(log, 'Necrons')).toBe('| Necrons | ~1 | — | ▲1 (+20) |');
    expect(row(log, 'Orks')).toBe('| Orks | ~1 | — | ▼1 (-5) |');
  });

  it('names the note behind a row that has nothing to count', () => {
    const before = [necronsContent(), asOrks(necronsContent())];
    const bumped = { ...necronsContent(), version: '1.2' };
    const other = asOrks(necronsContent());
    reprice(other, 5);
    const log = changelog(before, [bumped, other], { today: '2026-08-31' });
    expect(log).toContain('| Necrons _(v1.1 → v1.2)_ | — | — | — |');
    // …and the section below it says so too, instead of a bare heading.
    expect(log).toContain('## Necrons  _(v1.1 → v1.2)_\n\n_No unit or detachment changes._');
  });
});

describe('folding a long change list', () => {
  it('leaves a short list expanded', () => {
    const after = necronsContent();
    reprice(after, 5);
    expect(changelog([necronsContent()], [after], { today: '2026-08-31' })).not.toContain(
      '<details>',
    );
  });

  it('folds a long list into a collapsed <details> block', () => {
    const after = necronsContent();
    for (const u of after.units) for (const t of u.pricing) for (const c of t.costs) c.points += 5;
    const log = changelog([necronsContent()], [after], { today: '2026-08-31' });
    expect(log).toContain('<summary><strong>Per-faction detail</strong> — 1 faction, ');
    // The summary and table stay outside the fold; only the detail is hidden.
    expect(log.indexOf('<details>')).toBeGreaterThan(log.indexOf('**1 faction changed**'));
    expect(log.indexOf('## Necrons')).toBeGreaterThan(log.indexOf('<details>'));
    expect(log.trimEnd().endsWith('</details>')).toBe(true);
  });
});

describe('naming an update after its MFM version', () => {
  const row = (log: string, name: string) =>
    log.split('\n').find((l) => l.startsWith(`| ${name} `)) ?? '';

  it("prefers meta.yaml's site-wide version over the factions' own", () => {
    const after = necrons('2026-08-31');
    reprice(after, 5);
    expect(updateTitle([necrons('2026-06-17')], [after], { version: '1.3' })).toBe(
      'MFM v1.3 update — 2026-08-31',
    );
  });

  it('takes the version most factions carry when a page lags a revision behind', () => {
    const before = [necronsContent(), asOrks(necronsContent())];
    const moved = { ...necronsContent(), version: '1.3' };
    reprice(moved, 5);
    const lagging = { ...asOrks(necronsContent()), version: '1.2' };
    const alsoMoved = { ...asOrks(necronsContent()), slug: 'tyranids', name: 'Tyranids' };
    alsoMoved.version = '1.3';
    expect(updateTitle(before, [moved, lagging, alsoMoved], { today: '2026-08-31' })).toBe(
      'MFM v1.3 update — 2026-08-31',
    );
  });

  it('states a version bump every faction shares once, not on each row', () => {
    const before = [necronsContent(), asOrks(necronsContent())];
    const n = { ...necronsContent(), version: '1.2' };
    reprice(n, 5);
    const o = { ...asOrks(necronsContent()), version: '1.2' };
    reprice(o, -5);
    const log = changelog(before, [n, o], { today: '2026-08-31' });
    expect(log).toContain('**2 factions changed** · all v1.1 → v1.2 ·');
    // Not repeated on the rows — that would read as "these are the ones that bumped".
    expect(row(log, 'Necrons')).toBe('| Necrons | ~1 | — | ▲1 (+5) |');
    expect(row(log, 'Orks')).toBe('| Orks | ~1 | — | ▼1 (-5) |');
    // The sections keep it, so one read on its own is still true.
    expect(log).toContain('## Necrons  _(v1.1 → v1.2)_');
  });

  it('keeps the note on the rows when only some factions bumped', () => {
    const before = [necronsContent(), asOrks(necronsContent())];
    const n = { ...necronsContent(), version: '1.2' };
    reprice(n, 5);
    const o = asOrks(necronsContent());
    reprice(o, -5);
    const log = changelog(before, [n, o], { today: '2026-08-31' });
    expect(log).not.toContain('· all v1.1 → v1.2');
    expect(row(log, 'Necrons')).toBe('| Necrons _(v1.1 → v1.2)_ | ~1 | — | ▲1 (+5) |');
  });
});

describe('re-tiered pricing (a scheme change, not an add plus a remove)', () => {
  /**
   * GW's recurring MFM move: a unit priced over one tier gains a requisition threshold,
   * so the same unit is now costed `1st–2nd` / `3rd+`. Every cost row is keyed by its
   * tier, so row-by-row this reads as a wall of removals and additions — in v1.3, eight
   * such units produced 45 of the changelog's 70 add/remove lines.
   */
  const retier = (bump = 30): FactionContent => {
    const after = necronsContent();
    const warriors = after.units.find((u) => u.name === 'Necron Warriors');
    const base = warriors?.pricing[0];
    if (!warriors || !base) throw new Error('fixture changed');
    warriors.pricing = [
      { ...base, range: '[1,2]', label: 'Your 1st To 2nd Units Cost' },
      {
        ...base,
        range: '[3,)',
        label: 'Your 3rd + Units Cost',
        costs: base.costs.map((c) => ({ ...c, points: c.points + bump })),
      },
    ];
    return after;
  };

  it('reports one line instead of a row-per-tier wall of additions and removals', () => {
    const log = changelog([necronsContent()], [retier()]);
    expect(log).toContain('**Unit pricing re-tiered:**');
    expect(log).toContain('Necron Warriors — re-tiered [1,) → [1,2] + [3,)');
    // The old prices and both new tiers are all still there, per option.
    expect(log).toContain('10 models: 80 → 80 / 110');
    // …and none of it is dressed up as an addition or a removal.
    expect(log).not.toContain('➕');
    expect(log).not.toContain('➖');
  });

  it('counts the unit as changed, and says how many were re-tiered', () => {
    const log = changelog([necronsContent()], [retier()]);
    expect(log).toContain('units ~1');
    expect(log).toContain('1 unit re-tiered');
  });

  it('files it under Changed in DATA-CHANGELOG.md, never Added or Removed', () => {
    const entry = changelogEntry([necronsContent()], [retier()], { date: '2026-08-31' });
    expect(entry).toContain('### Changed');
    expect(entry).not.toContain('### Added');
    expect(entry).not.toContain('### Removed');
    expect(entry).toContain('**Necrons**: Necron Warriors — re-tiered');
  });

  it('still reports a plain reprice normally when the tiers are untouched', () => {
    const after = necronsContent();
    const opt = after.units
      .find((u) => u.name === 'Necron Warriors')
      ?.pricing[0]?.costs.find((c) => c.models === 10);
    if (opt) opt.points += 10;
    const log = changelog([necronsContent()], [after]);
    expect(log).toContain('Necron Warriors — 10 models: 80 → 90 pts (**+10**)');
    expect(log).not.toContain('re-tiered');
  });

  it('handles tiers collapsing back to one, the reverse of the v1.3 move', () => {
    const log = changelog([retier()], [necronsContent()]);
    expect(log).toContain('Necron Warriors — re-tiered [1,2] + [3,) → [1,)');
    expect(log).toContain('10 models: 80 / 110 → 80');
    expect(log).not.toContain('➕');
    expect(log).not.toContain('➖');
  });
});

describe('the changed-unit count covers everything a unit can change', () => {
  const withRod = (points: number): FactionContent => {
    const f = necronsContent();
    const tech = f.units.find((u) => u.name === 'Technomancer');
    if (!tech) throw new Error('fixture changed');
    tech.wargear = [{ item: 'Test Rod', points }];
    return f;
  };

  it('counts a unit whose only change is a wargear price', () => {
    expect(changelog([withRod(10)], [withRod(15)])).toContain('units ~1');
  });

  it('counts a unit once when its cost and its wargear both moved', () => {
    const after = withRod(15);
    const tech = after.units.find((u) => u.name === 'Technomancer');
    const cost = tech?.pricing[0]?.costs[0];
    if (cost) cost.points += 5;
    // Two changes, one unit — the tally is of units touched, not of changes.
    expect(changelog([withRod(10)], [after])).toContain('units ~1');
  });
});
