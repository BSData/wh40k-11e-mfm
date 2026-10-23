import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POINTS_COLUMNS, pointsCsv } from '../src/csv.js';
import { loadFactionDir } from '../src/diff.js';
import type { Faction } from '../src/model.js';

/** `data/points.csv`, the flat points table (see "Points table" in specs/data-model.md). */

const DATA = fileURLToPath(new URL('./golden/data-v1.6', import.meta.url));

const tiny: Faction = {
  name: 'Necrons',
  slug: 'necrons',
  version: '1.6',
  firstSeen: '2026-10-14',
  detachments: [],
  units: [
    {
      name: 'Technomancer',
      pricing: [
        { range: '[1,1]', label: 'Your 1st Unit Costs', costs: [{ models: 1, points: 80 }] },
        { range: '[2,)', label: 'Your 2nd + Unit Costs', costs: [{ models: 1, points: 90 }] },
      ],
    },
    {
      name: 'Canoptek Wraiths',
      groupTitle: 'Test Group',
      legends: true,
      pricing: [
        {
          range: '[1,)',
          label: 'Your Unit Costs',
          costs: [
            { models: 3, points: 110 },
            { models: 6, points: 220, desc: '3 Wraiths, 3 "Scarabs"' },
            { models: 1, points: 15, desc: 'Scarab', addon: true },
          ],
        },
      ],
    },
  ],
};

describe('pointsCsv', () => {
  it('writes a header, then one row per faction, unit, tier and cost option', () => {
    expect(pointsCsv([tiny])).toBe(
      [
        POINTS_COLUMNS.join(','),
        'necrons,Canoptek Wraiths,Test Group,true,"[1,)",Your Unit Costs,3,110,,',
        'necrons,Canoptek Wraiths,Test Group,true,"[1,)",Your Unit Costs,6,220,"3 Wraiths, 3 ""Scarabs""",',
        'necrons,Canoptek Wraiths,Test Group,true,"[1,)",Your Unit Costs,1,15,Scarab,true',
        'necrons,Technomancer,,,"[1,1]",Your 1st Unit Costs,1,80,,',
        'necrons,Technomancer,,,"[2,)",Your 2nd + Unit Costs,1,90,,',
        '',
      ].join('\n'),
    );
  });

  it('has a row for every cost option of the dataset', () => {
    const factions = loadFactionDir(DATA);
    const options = factions
      .flatMap((f) => f.units)
      .flatMap((u) => u.pricing)
      .reduce((n, t) => n + t.costs.length, 0);
    expect(pointsCsv(factions).split('\n').length).toBe(options + 2); // + header + final ''
  });

  it('orders factions by slug, however they were listed', () => {
    const factions = loadFactionDir(DATA);
    expect(pointsCsv([...factions].reverse())).toBe(pointsCsv(factions));
  });

  it('orders units by name, as the files do, keeping same-named ones in page order', () => {
    const [technomancer, wraiths] = tiny.units;
    if (!technomancer || !wraiths) throw new Error('fixture changed');
    // As `--order page` writes it: a second, Legends Technomancer last on the page.
    const page: Faction = {
      ...tiny,
      units: [technomancer, wraiths, { ...technomancer, legends: true }],
    };
    const rows = pointsCsv([page]).split('\n').slice(1, -1);
    expect(rows.map((r) => r.split(',').slice(1, 4).join(','))).toEqual([
      'Canoptek Wraiths,Test Group,true',
      'Canoptek Wraiths,Test Group,true',
      'Canoptek Wraiths,Test Group,true',
      'Technomancer,,',
      'Technomancer,,',
      'Technomancer,,true',
      'Technomancer,,true',
    ]);
  });
});

describe('a single points change is a one-line diff', () => {
  const factions = loadFactionDir(DATA);
  const before = pointsCsv(factions).split('\n');
  const necrons = factions.find((f) => f.slug === 'necrons');
  if (!necrons) throw new Error('fixture changed');

  // Every cost option of a whole faction, each repriced on its own, to the cheapest
  // possible value and to a big one, so the row can't sort anywhere else.
  const options = necrons.units.flatMap((u, unit) =>
    u.pricing.flatMap((t, tier) => t.costs.map((_, cost) => ({ name: u.name, unit, tier, cost }))),
  );
  it.each(options)('$name, tier $tier, option $cost', ({ unit, tier, cost }) => {
    for (const points of [0, 9999]) {
      const changed = structuredClone(factions);
      const option = changed.find((f) => f.slug === 'necrons')?.units[unit]?.pricing[tier]?.costs[
        cost
      ];
      if (!option || option.points === points) continue;
      option.points = points;
      const after = pointsCsv(changed).split('\n');
      expect(after.length).toBe(before.length);
      const moved = after.flatMap((line, i) => (line === before[i] ? [] : [[before[i], line]]));
      expect(moved).toHaveLength(1);
      expect(moved[0]?.[1]).toContain(`,${points},`);
    }
  });
});

describe('the committed data/points.csv', () => {
  it('is the table the committed faction files make', () => {
    const data = fileURLToPath(new URL('../data', import.meta.url));
    expect(readFileSync(`${data}/points.csv`, 'utf8')).toBe(pointsCsv(loadFactionDir(data)));
  });
});
