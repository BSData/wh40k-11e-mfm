import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changelog, changelogEntry, failuresReport } from '../src/diff.js';
import { factionFromYaml, factionToYaml, metaFromYaml, metaToYaml } from '../src/emit.js';
import type { Faction, FactionContent } from '../src/model.js';
import { parseFaction } from '../src/parse.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const necronsContent = (): FactionContent =>
  parseFaction(fixture('necrons.html'), 'necrons', 'Necrons');
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

  it('quotes the version and includes firstSeen', () => {
    const yaml = factionToYaml(necrons('2026-06-17'));
    expect(yaml).toContain('version: "1.0"');
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

  it('reports wargear, role and attach-list changes', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const tech = after.units.find((u) => u.name === 'Technomancer');
    if (tech) {
      tech.role = 'leader';
      tech.attachTo = ['Immortals'];
      tech.wargear = [{ item: 'Test Rod', points: 15 }];
    }
    const tb = before.units.find((u) => u.name === 'Technomancer');
    if (tb) tb.wargear = [{ item: 'Test Rod', points: 10 }];
    const log = changelog([before], [after]);
    expect(log).toContain('Technomancer — Test Rod: 10 → 15 pts (**+5**)');
    expect(log).toContain('Technomancer — role: support → leader');
    expect(log).toContain('Technomancer — attaches to:');
  });

  it('reports detachment DP and objective changes', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const det = after.detachments.find((d) => d.name === 'Annihilation Legion');
    if (det) {
      det.dp = 3;
      det.objective = 'NEW OBJECTIVE';
    }
    const log = changelog([before], [after]);
    expect(log).toContain('Annihilation Legion — DP: 2 → 3');
    expect(log).toContain('Annihilation Legion — objective: PURGE THE FOE → NEW OBJECTIVE');
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

  it('reports a detachment unique change and an enhancement leaderTo change', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const dyn = after.detachments.find((d) => d.name === 'Awakened Dynasty');
    if (dyn) dyn.unique = 'Hypercrypt';
    const murdermind = after.detachments
      .find((d) => d.name === 'Cursed Legion')
      ?.enhancements.find((e) => e.name === 'Murdermind');
    if (murdermind) murdermind.leaderTo = ['Lokhust Destroyers'];
    const log = changelog([before], [after]);
    expect(log).toContain('Awakened Dynasty — unique: Dynasty → Hypercrypt');
    expect(log).toContain('Cursed Legion · Murdermind — leaderTo:');
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
    expect(entry).toContain('## [2026-06-23] — MFM v1.0');
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
