import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FactionContent, SiteIndex } from '../src/model.js';
import { extractNotesMarkdown, markLegends, parseFaction, parseIndex } from '../src/parse.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('parseIndex', () => {
  const index = parseIndex(fixture('index.html'));

  it('passes the schema', () => {
    expect(() => SiteIndex.parse(index)).not.toThrow();
  });

  it('extracts the site version', () => {
    expect(index.version).toBe('1.0');
  });

  it('finds all 30 factions with clean display names', () => {
    expect(index.factions).toHaveLength(30);
    expect(index.factions).toContainEqual({ slug: 'necrons', name: 'Necrons' });
    expect(index.factions).toContainEqual({ slug: 'tau-empire', name: 'T’au Empire' });
  });
});

describe('parseFaction (necrons)', () => {
  const faction = parseFaction(fixture('necrons.html'), 'necrons', 'Necrons');
  const unit = (name: string) => faction.units.find((u) => u.name === name);

  it('passes the schema', () => {
    expect(() => FactionContent.parse(faction)).not.toThrow();
  });

  it('captures version, units and detachments', () => {
    expect(faction.version).toBe('1.0');
    expect(faction.units).toHaveLength(52);
    expect(faction.detachments).toHaveLength(12);
  });

  it('has no parent or group title (top-level faction)', () => {
    expect(faction.parent).toBeUndefined();
    expect(faction.groupTitle).toBeUndefined();
  });

  it('parses a simple single-option unit', () => {
    expect(unit('Canoptek Doomstalker')?.pricing).toEqual([
      { range: '[1,)', label: 'Your Unit Costs', costs: [{ models: 1, points: 140 }] },
    ]);
  });

  it('parses a multi-model-count unit with numeric model counts', () => {
    expect(unit('Necron Warriors')?.pricing).toEqual([
      {
        range: '[1,)',
        label: 'Your Unit Costs',
        costs: [
          { models: 10, points: 80 },
          { models: 20, points: 190 },
        ],
      },
    ]);
  });

  it('parses per-instance tiered pricing into interval ranges', () => {
    const pricing = unit('Lokhust Heavy Destroyers')?.pricing;
    expect(pricing).toHaveLength(2);
    expect(pricing?.[0]).toEqual({
      range: '[1,2]',
      label: 'Your 1st To 2nd Units Cost',
      costs: [
        { models: 1, points: 50 },
        { models: 2, points: 100 },
        { models: 3, points: 150 },
      ],
    });
    expect(pricing?.[1]?.range).toBe('[3,)');
  });

  it('parses Support role with attach list', () => {
    const tech = unit('Technomancer');
    expect(tech?.role).toBe('support');
    expect(tech?.attachTo).toEqual(['Canoptek Wraiths', 'Immortals', 'Necron Warriors']);
  });

  it('parses a detachment with objective and enhancements', () => {
    const det = faction.detachments.find((d) => d.name === 'Annihilation Legion');
    expect(det?.dp).toBe(2);
    expect(det?.objective).toBe('PURGE THE FOE');
    expect(det?.enhancements).toContainEqual({ name: 'Eldritch Nightmare', points: 10 });
    expect(det?.enhancements).toHaveLength(4);
    // a plain detachment has no UNIQUE banner, and none of its enhancements grant Leader
    expect(det?.unique).toBeUndefined();
    expect(det?.enhancements.every((e) => e.leaderTo === undefined)).toBe(true);
  });

  it('captures the UNIQUE restriction on detachments', () => {
    expect(faction.detachments.find((d) => d.name === 'Awakened Dynasty')?.unique).toBe('Dynasty');
    expect(faction.detachments.find((d) => d.name === 'Hypercrypt Legion')?.unique).toBe(
      'Hypercrypt',
    );
  });

  it('attaches a LEADER grant to the enhancement that unlocks it', () => {
    const cursed = faction.detachments.find((d) => d.name === 'Cursed Legion');
    const murdermind = cursed?.enhancements.find((e) => e.name === 'Murdermind');
    expect(murdermind?.leaderTo).toEqual([
      'Lokhust Destroyers',
      'Skorpekh Destroyers',
      'Lokhust Heavy Destroyers',
      'Ophydian Destroyers',
    ]);
    // the other enhancements in the same detachment carry no grant
    expect(cursed?.enhancements.find((e) => e.name === 'Destroyer Ankh')?.leaderTo).toBeUndefined();
  });

  it('matches the full snapshot', () => {
    expect(faction).toMatchSnapshot();
  });
});

describe('parseFaction (black-templars) — streamed cards & composite sizes', () => {
  const faction = parseFaction(
    fixture('black-templars.html'),
    'black-templars',
    'Black Templars',
    new Set(['space marines']),
  );

  it('passes the schema and finds units', () => {
    expect(() => FactionContent.parse(faction)).not.toThrow();
    expect(faction.units.length).toBeGreaterThan(20);
  });

  it('captures the parent army when the title names a known faction', () => {
    expect(faction.parent).toBe('Space Marines');
    expect(faction.groupTitle).toBeUndefined();
  });

  it('routes the army-group title to groupTitle when it is not a known faction', () => {
    const orphan = parseFaction(
      fixture('black-templars.html'),
      'black-templars',
      'Black Templars',
      new Set(),
    );
    expect(orphan.parent).toBeUndefined();
    expect(orphan.groupTitle).toBe('Space Marines');
  });

  it('keeps composite descriptions and sums their model counts', () => {
    const crusaders = faction.units.find((u) => u.name === 'Crusader Squad');
    expect(crusaders?.pricing[0]?.costs).toEqual([
      { models: 10, points: 150, desc: '1 Sword Brother, 4 Neophytes, 5 Initiates' },
      { models: 20, points: 290, desc: '1 Sword Brother, 8 Neophytes, 11 Initiates' },
    ]);
  });

  it('flags "+" add-on options with the item as desc', () => {
    const outrider = faction.units.find((u) => u.name === 'Outrider Squad');
    const addon = outrider?.pricing[0]?.costs.find((c) => c.addon);
    expect(addon).toEqual({ models: 1, points: 60, desc: 'Invader ATV', addon: true });
  });

  it('parses wargear options with per-item costs', () => {
    const dread = faction.units.find((u) => u.name === 'Redemptor Dreadnought');
    expect(dread?.wargear).toEqual([{ item: 'Macro plasma incinerator', points: 10 }]);
  });
});

describe('markLegends (necrons base vs legends-on render)', () => {
  const base = parseFaction(fixture('necrons.html'), 'necrons', 'Necrons');
  const full = parseFaction(fixture('necrons-legends.html'), 'necrons', 'Necrons');

  it('flags exactly the units the legends render adds', () => {
    const marked = markLegends(base, full);
    const legends = marked.units.filter((u) => u.legends);
    const current = marked.units.filter((u) => !u.legends);
    expect(current).toHaveLength(base.units.length); // 52 current
    expect(legends.length).toBe(full.units.length - base.units.length); // +12 legends
    expect(legends.map((u) => u.name)).toContain('Anrakyr The Traveller');
    // a flagged legends unit still parses fully (pricing, role)
    const anrakyr = legends.find((u) => u.name === 'Anrakyr The Traveller');
    expect(anrakyr?.role).toBe('leader');
    expect(anrakyr?.pricing[0]?.costs[0]).toEqual({ models: 1, points: 95 });
  });

  it('leaves current units unflagged', () => {
    const marked = markLegends(base, full);
    expect(marked.units.find((u) => u.name === 'Necron Warriors')?.legends).toBeUndefined();
  });
});

describe('extractNotesMarkdown — the "Welcome…" notes as Markdown', () => {
  const md = extractNotesMarkdown(fixture('necrons-legends.html'));

  it('keeps the structure: headings, bullet lists and bold', () => {
    expect(md.startsWith('To muster a Warhammer 40,000 army')).toBe(true);
    expect(md).toContain('## UNITS');
    expect(md).toContain('## DETACHMENTS');
    expect(md).toContain('- **Starting Strength**: The number of models');
    expect(md).toContain('- **Unique Tag**: Some **detachments** are tagged');
    expect(md).toContain('the **Leader/Support** ability');
  });

  it('emits no raw HTML and no runs of blank lines', () => {
    expect(md).not.toMatch(/<[a-z]/i);
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('returns empty string when no notes block is present (HTTP base render)', () => {
    // On the plain HTTP page the notes live inside a <template>, so they are not
    // reachable as a div/section — only the browser render exposes them.
    expect(extractNotesMarkdown(fixture('necrons.html'))).toBe('');
  });
});

describe('parseFaction coverage guard — nothing on the page goes unconsumed', () => {
  it('accepts the real fixtures (everything is accounted for)', () => {
    expect(() => parseFaction(fixture('necrons.html'), 'necrons', 'Necrons')).not.toThrow();
    expect(() =>
      parseFaction(fixture('black-templars.html'), 'black-templars', 'Black Templars'),
    ).not.toThrow();
    expect(() =>
      parseFaction(fixture('titan-legions.html'), 'titan-legions', 'Titan Legions'),
    ).not.toThrow();
  });

  it('throws, located, when the page has content no selector captured', () => {
    const injected = fixture('necrons.html').replace(
      '</body>',
      '<div>SURPRISE NEW MFM SECTION</div></body>',
    );
    expect(injected).not.toBe(fixture('necrons.html')); // sanity: the marker was inserted
    expect(() => parseFaction(injected, 'necrons', 'Necrons')).toThrow(/Unconsumed content/);
    expect(() => parseFaction(injected, 'necrons', 'Necrons')).toThrow(/SURPRISE NEW MFM SECTION/);
  });
});

describe('parseFaction (titan-legions) — thousands-separator points', () => {
  const faction = parseFaction(fixture('titan-legions.html'), 'titan-legions', 'Titan Legions');

  it('parses "2,200 pts" as 2200, not 200', () => {
    const allCosts = faction.units.flatMap((u) => u.pricing.flatMap((t) => t.costs));
    // every titan costs four figures; none should be misparsed into the hundreds
    expect(allCosts.every((c) => c.points >= 1000)).toBe(true);
    expect(allCosts.some((c) => c.points === 2200)).toBe(true);
  });
});
