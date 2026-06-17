import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changelog } from '../src/diff.js';
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
      'No points changes detected.\n',
    );
  });

  it('reports a points change with signed delta', () => {
    const before = necronsContent();
    const after = structuredClone(before);
    const warriors = after.units.find((u) => u.name === 'Necron Warriors');
    const opt = warriors?.pricing[0]?.costs.find((c) => c.models === 10);
    if (opt) opt.points += 10;
    const log = changelog([before], [after]);
    expect(log).toContain('### Necrons');
    expect(log).toContain('Necron Warriors — 10 models: 80 → 90 pts (+10)');
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
    expect(log).toContain('➖ Removed unit: Necron Warriors');
    expect(log).toContain('➕ New unit: Test Construct');
  });

  it('reports a brand new faction', () => {
    expect(changelog([], [necronsContent()])).toContain('➕ New faction');
  });
});
