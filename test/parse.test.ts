import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { factionFromYaml, mapNames } from '../src/emit.js';
import { FactionContent, SiteIndex } from '../src/model.js';
import {
  extractMusterMarkdown,
  extractNotesMarkdown,
  markLegends,
  nameCase,
  OFFICIAL_SPELLINGS,
  parseFaction,
  parseIndex,
} from '../src/parse.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('parseIndex', () => {
  const index = parseIndex(fixture('index.html'));

  it('passes the schema', () => {
    expect(() => SiteIndex.parse(index)).not.toThrow();
  });

  it('extracts the site version', () => {
    expect(index.version).toBe('1.1');
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
    expect(faction.version).toBe('1.1');
    expect(faction.units).toHaveLength(52);
    expect(faction.detachments).toHaveLength(12);
  });

  it('has no parent and no unit sub-groups (top-level faction)', () => {
    expect(faction.parent).toBeUndefined();
    expect(faction.units.every((u) => u.groupTitle === undefined)).toBe(true);
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
        { models: 3, points: 160 },
      ],
    });
    expect(pricing?.[1]?.range).toBe('[3,)');
  });

  it('parses a Support role into supportTo, leaving leaderTo absent', () => {
    const tech = unit('Technomancer');
    expect(tech?.supportTo).toEqual(['Canoptek Wraiths', 'Immortals', 'Necron Warriors']);
    expect(tech?.leaderTo).toBeUndefined();
  });

  it('parses a detachment with objective and enhancements', () => {
    const det = faction.detachments.find((d) => d.name === 'Annihilation Legion');
    expect(det?.dp).toBe(2);
    expect(det?.objectives).toEqual(['PURGE THE FOE']);
    expect(det?.enhancements).toContainEqual({ name: 'Eldritch Nightmare', points: 10 });
    expect(det?.enhancements).toHaveLength(4);
    // a plain detachment has no UNIQUE banner, and none of its enhancements grant a role
    expect(det?.unique).toBeUndefined();
    expect(
      det?.enhancements.every((e) => e.leaderTo === undefined && e.supportTo === undefined),
    ).toBe(true);
  });

  it('captures the UNIQUE restriction on detachments', () => {
    expect(faction.detachments.find((d) => d.name === 'Awakened Dynasty')?.unique).toBe('Dynasty');
    expect(faction.detachments.find((d) => d.name === 'Hypercrypt Legion')?.unique).toBe(
      'Hypercrypt',
    );
  });

  it('attaches a SUPPORT grant to the enhancement that unlocks it', () => {
    const cursed = faction.detachments.find((d) => d.name === 'Cursed Legion');
    const murdermind = cursed?.enhancements.find((e) => e.name === 'Murdermind');
    // "SUPPORT:" grants are the Support-role counterpart of "LEADER:"/`leaderTo`.
    expect(murdermind?.supportTo).toEqual([
      'Skorpekh Destroyers',
      'Lokhust Destroyers',
      'Ophydian Destroyers',
      'Lokhust Heavy Destroyers',
    ]);
    expect(murdermind?.leaderTo).toBeUndefined();
    // the other enhancements in the same detachment carry no grant
    expect(
      cursed?.enhancements.find((e) => e.name === 'Destroyer Ankh')?.supportTo,
    ).toBeUndefined();
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

  it('tags units with their sub-group and surfaces a faction parent when it names a faction', () => {
    // The shared roster sits under a "Space Marines" sub-group header; the chapter's own
    // units (under the bare UNITS section) have no group.
    expect(faction.units.find((u) => u.name === 'Aggressor Squad')?.groupTitle).toBe(
      'Space Marines',
    );
    expect(faction.units.find((u) => u.name === 'Crusader Squad')?.groupTitle).toBeUndefined();
    // "Space Marines" names another faction, so it is also surfaced at the faction level.
    expect(faction.parent).toBe('Space Marines');
  });

  it('keeps unit groupTitle but drops faction parent when the group is not a known faction', () => {
    const orphan = parseFaction(
      fixture('black-templars.html'),
      'black-templars',
      'Black Templars',
      new Set(),
    );
    expect(orphan.parent).toBeUndefined();
    // The per-unit grouping does not depend on the faction list.
    expect(orphan.units.find((u) => u.name === 'Aggressor Squad')?.groupTitle).toBe(
      'Space Marines',
    );
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

describe('parseFaction (space-marines, v1.6) — the v1.4 structures', () => {
  const faction = parseFaction(fixture('space-marines.html'), 'space-marines', 'Space Marines');
  const unit = (name: string) => faction.units.find((u) => u.name === name);

  it('passes the schema', () => {
    expect(() => FactionContent.parse(faction)).not.toThrow();
    expect(faction.version).toBe('1.6');
  });

  it('reads both role blocks of a unit that has a Leader and a Support list', () => {
    // Two blocks with the same list: each is consumed, so neither is left over.
    expect(unit('Cato Sicarius')).toMatchObject({
      groupTitle: 'Ultramarines',
      leaderTo: ['Victrix Honour Guard'],
      supportTo: ['Victrix Honour Guard'],
    });
  });

  it('reads every Force Disposition of a detachment that grants two', () => {
    const gladius = faction.detachments.find((d) => d.name === 'Gladius Task Force');
    expect(gladius?.objectives).toEqual(['TAKE AND HOLD', 'PRIORITY ASSETS']);
  });

  it('strips the "BODYGUARD UNITS UPDATED" note and keeps the list it annotates', () => {
    expect(fixture('space-marines.html')).toContain('BODYGUARD UNITS UPDATED');
    expect(unit('Judiciar')?.supportTo).toContain('Sword Brethren Squad');
    expect(JSON.stringify(faction)).not.toMatch(/UPDATED|BODYGUARD/);
  });
});

describe('parseFaction (adeptus-custodes, v1.6) — the "WARGEAR COSTS REMOVED" note', () => {
  const faction = parseFaction(
    fixture('adeptus-custodes.html'),
    'adeptus-custodes',
    'Adeptus Custodes',
  );

  it('strips the note and reads the card it sits on', () => {
    expect(fixture('adeptus-custodes.html')).toContain('WARGEAR COSTS REMOVED');
    const caladius = faction.units.find((u) => u.name === 'Caladius Grav-Tank');
    expect(caladius?.pricing.map((t) => t.costs)).toEqual([
      [{ models: 1, points: 230 }],
      [{ models: 1, points: 260 }],
    ]);
    expect(caladius?.wargear).toBeUndefined();
    expect(JSON.stringify(faction)).not.toMatch(/UPDATED|WARGEAR COSTS/);
  });
});

describe('names — the "Names" rule in specs/data-model.md', () => {
  const templars = parseFaction(
    fixture('black-templars.html'),
    'black-templars',
    'Black Templars',
    new Set(['space marines']),
  );
  const necrons = parseFaction(fixture('necrons-legends.html'), 'necrons', 'Necrons');
  const unitNames = (f: FactionContent) => f.units.map((u) => u.name);
  const detachmentNames = (f: FactionContent) => f.detachments.map((d) => d.name);

  it('keeps a letter after an apostrophe lower-case, whichever apostrophe the site uses', () => {
    expect(fixture('black-templars.html')).toContain('EMPEROR’S CHAMPION');
    expect(unitNames(templars)).toContain('Emperor’s Champion');
    expect(detachmentNames(templars)).toContain("Marshal's Household");
    expect(unitNames(necrons)).toContain('C’tan Shard of the Deceiver');
  });

  it('keeps the minor words lower-case unless a name starts with one', () => {
    expect(unitNames(necrons)).toContain('Anrakyr the Traveller');
    expect(unitNames(necrons)).toContain('Overlord with Translocation Shroud');
    expect(detachmentNames(necrons)).toContain("The Phaeron's Armoury");
  });

  it('capitalises the word after an opening quote or bracket, not the minor words', () => {
    // As the live Astra Militarum page writes it; no fixture has the unit.
    expect(nameCase('‘IRON HAND’ STRAKEN')).toBe('‘Iron Hand’ Straken');
    expect(nameCase("'IRON HAND' STRAKEN")).toBe("'Iron Hand' Straken");
    expect(nameCase('KNIGHT (WITH SHIELD)')).toBe('Knight (with Shield)');
  });

  it('capitalises a first letter outside a–z', () => {
    expect(nameCase('ÛTHAR THE DESTINED')).toBe('Ûthar the Destined');
  });

  it('capitalises each part of a hyphenated word, minor words aside', () => {
    expect(nameCase('SHIELD-CAPTAIN')).toBe('Shield-Captain');
    expect(nameCase('VOIDSMEN-AT-ARMS')).toBe('Voidsmen-at-Arms');
    expect(nameCase('CALADIUS ANNIHILATOR GRAV‑TANK')).toBe('Caladius Annihilator Grav‑Tank');
  });

  it('takes the official spellings as listed, keeping the site’s apostrophes and hyphens', () => {
    expect(nameCase('LION EL’JONSON')).toBe('Lion El’Jonson');
    expect(nameCase("LION EL'JONSON")).toBe("Lion El'Jonson");
    expect(nameCase('CENTAUR RSV')).toBe('Centaur RSV');
    expect(nameCase('INVADER ATVS')).toBe('Invader ATVs');
    expect(nameCase('AX-1-0 TIGER SHARK')).toBe('AX-1-0 Tiger Shark');
    expect(nameCase('AX‑1‑0 TIGER SHARK')).toBe('AX‑1‑0 Tiger Shark');
  });

  it('sees an official spelling or a minor word through the punctuation around it', () => {
    expect(nameCase('CENTAUR (RSV)')).toBe('Centaur (RSV)');
    expect(nameCase('“XV9” HAZARD')).toBe('“XV9” Hazard');
    expect(nameCase('BANNER OF, AND FOR, THE CHAPTER')).toBe('Banner of, and for, the Chapter');
    expect(nameCase('ORDO HERETICUS, PURGATION FORCE')).toBe('Ordo Hereticus, Purgation Force');
  });

  describe('every committed name', () => {
    const dir = fileURLToPath(new URL('../data/', import.meta.url));
    // Every name the rule covers, with its file.
    const names = readdirSync(dir)
      .filter((file) => file.endsWith('.yaml') && file !== 'meta.yaml')
      .flatMap((file) => {
        const found: { file: string; name: string }[] = [];
        mapNames(factionFromYaml(readFileSync(join(dir, file), 'utf8')), (name) => {
          found.push({ file, name });
          return name;
        });
        return found;
      });
    const where = ({ file, name }: { file: string; name: string }) => `${file}: ${name}`;
    const curly = (s: string) => s.replace(/'/g, '’');
    const official = new Set(OFFICIAL_SPELLINGS.map(curly));

    it('has no capital after an apostrophe inside a word, but in the official spellings', () => {
      expect(names.length).toBeGreaterThan(1000);
      const capitalAfterApostrophe = names.filter(({ name }) =>
        name.split(' ').some((word) => /\p{L}['’]\p{Lu}/u.test(word) && !official.has(curly(word))),
      );
      expect(capitalAfterApostrophe.map(where)).toEqual([]);
    });

    it('is cased by the current rule, so data/ was regenerated after a change to it', () => {
      const stale = names.filter(({ name }) => nameCase(name.toUpperCase()) !== name);
      expect(stale.map(where)).toEqual([]);
    });
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
    expect(legends.map((u) => u.name)).toContain('Anrakyr the Traveller');
    // a flagged legends unit still parses fully (pricing, role)
    const anrakyr = legends.find((u) => u.name === 'Anrakyr the Traveller');
    expect(anrakyr?.leaderTo?.length).toBeGreaterThan(0);
    expect(anrakyr?.pricing[0]?.costs[0]).toEqual({ models: 1, points: 95 });
  });

  it('leaves current units unflagged', () => {
    const marked = markLegends(base, full);
    expect(marked.units.find((u) => u.name === 'Necron Warriors')?.legends).toBeUndefined();
  });
});

describe('markLegends — same-named units', () => {
  const unit = (name: string, points: number, groupTitle?: string) => ({
    name,
    ...(groupTitle ? { groupTitle } : {}),
    pricing: [{ range: '[1,)', label: 'Your Unit Costs', costs: [{ models: 1, points }] }],
  });
  const faction = (units: ReturnType<typeof unit>[]) => ({
    slug: 'space-wolves',
    name: 'Space Wolves',
    version: '1.6',
    detachments: [],
    units,
  });

  it('tells same-named units apart by sub-group and by occurrence', () => {
    const base = faction([
      unit('Venerable Dreadnought', 130),
      unit('Venerable Dreadnought', 165),
      unit('Venerable Dreadnought', 140, 'Space Marines'),
    ]);
    // The Legends render lists the same three, then a Legends unit of the same name.
    const full = faction([...base.units, unit('Venerable Dreadnought', 150)]);
    const marked = markLegends(base, full);
    expect(marked.units.map((u) => u.legends ?? false)).toEqual([false, false, false, true]);
  });

  it('throws when a base unit is missing from the Legends render', () => {
    const base = faction([unit('Venerable Dreadnought', 130), unit('Venerable Dreadnought', 165)]);
    const full = faction([unit('Venerable Dreadnought', 130), unit('Bjorn the Fell-Handed', 170)]);
    expect(() => markLegends(base, full)).toThrow(/"space-wolves".*Venerable Dreadnought/);
  });
});

describe('extractNotesMarkdown — the "Welcome…" notes as Markdown', () => {
  // A render with both rules panels open (they are lazy — the legends render does not
  // include them), which is what `renderRulesPanels` feeds this pure function.
  const md = extractNotesMarkdown(fixture('necrons-panels.html'));

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

  it('takes only its own panel, not the neighbouring "Muster Armies" one', () => {
    expect(md).not.toContain('START YOUR ARMY ROSTER');
  });

  it('returns empty string when no notes block is present (HTTP base render)', () => {
    // On the plain HTTP page the panels are closed, so their bodies are not rendered
    // at all — only the browser render (with the panel open) exposes them.
    expect(extractNotesMarkdown(fixture('necrons.html'))).toBe('');
  });
});

describe('extractMusterMarkdown — the "Muster Armies" rules as Markdown', () => {
  const md = extractMusterMarkdown(fixture('necrons-panels.html'));

  it('keeps the structure: headings, bullet lists and bold', () => {
    expect(md.startsWith('The following rules tell you how to create an army list')).toBe(true);
    expect(md).toContain('## SELECT BATTLE SIZE');
    expect(md).toContain('## ATTACH LEADERS AND SUPPORT UNITS');
    expect(md).toContain('- No unit (including **attached** units) can have more than one');
    // An all-caps keyword inside running text, or a label that isn't all-caps, stays bold.
    expect(md).toContain('for **BATTLELINE** and **DEDICATED TRANSPORT** units');
    expect(md).toContain('**Upgrades:**');
  });

  it('renders the battle-size table as a Markdown table', () => {
    const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = (...cells: string[]) =>
      new RegExp(`^\\| ${cells.map(esc).join(' +\\| ')} +\\|$`, 'm');
    expect(md).toMatch(
      row(
        'Battle Size',
        'Points Total',
        'Detachment Points (DP)',
        'Enhancement Limit',
        'Unit Limit\\*',
      ),
    );
    expect(md).toMatch(row('INCURSION', '1000', '2', '2', '2'));
    expect(md).toMatch(row('STRIKE FORCE', '2000', '3', '4', '3'));
  });

  it('emits no raw HTML, no runs of blank lines and no trailing spaces', () => {
    expect(md).not.toMatch(/<[a-z]/i);
    expect(md).not.toMatch(/\n{3,}/);
    expect(md).not.toMatch(/ \n/);
  });

  it('returns empty string on the HTTP base render (panel closed)', () => {
    expect(extractMusterMarkdown(fixture('necrons.html'))).toBe('');
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
    expect(() =>
      parseFaction(fixture('space-marines.html'), 'space-marines', 'Space Marines'),
    ).not.toThrow();
    expect(() =>
      parseFaction(fixture('adeptus-custodes.html'), 'adeptus-custodes', 'Adeptus Custodes'),
    ).not.toThrow();
  });

  it('accounts for the rules panels — their labels, and their bodies when open', () => {
    // A browser render with both panels open: the "Muster Armies" label is allowlisted
    // and both panel bodies go to meta.yaml, so neither is unconsumed faction content.
    expect(() => parseFaction(fixture('necrons-panels.html'), 'necrons', 'Necrons')).not.toThrow();
  });

  it('drops the site footer (legal links) as chrome, like the header/nav', () => {
    // The footer arrived in October 2026 and failed every faction until it was dropped.
    expect(fixture('necrons-panels.html')).toMatch(/<footer[^>]*>.*Terms of Website Use/s);
    expect(() => parseFaction(fixture('necrons-panels.html'), 'necrons', 'Necrons')).not.toThrow();
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

describe('change annotations — the "changed since the last MFM" layer', () => {
  // After a points update GW decorates the affected cards with change chrome: a
  // coloured header, ▲/▼ direction glyphs, (±N) deltas, and an UPDATED badge. The
  // parser normalises it away so a changed card reads exactly like an unchanged one.
  const necrons = parseFaction(fixture('necrons.html'), 'necrons', 'Necrons');
  const sisters = parseFaction(
    fixture('adepta-sororitas.html'),
    'adepta-sororitas',
    'Adepta Sororitas',
  );
  // ▲/▼ glyphs, (±N) deltas, and every known UPDATED note.
  const MARKER = /[▲▼]|\([-+−][\d,]+\)|UPDATED|FORCE DISPOSITION|REQUISITION THRESHOLDS|UNIQUE TAG/;

  it('finds a unit whose header was restyled by a points change', () => {
    // Canoptek Reanimator's points went up, so its card renders in the "changed"
    // style (coloured flex-row header, name in a span, a ▲ badge) instead of the
    // plain `div.bg-slate-500.text-xl` header — it must still be found and parsed.
    expect(necrons.units.find((u) => u.name === 'Canoptek Reanimator')?.pricing).toEqual([
      { range: '[1,)', label: 'Your Unit Costs', costs: [{ models: 1, points: 75 }] },
    ]);
  });

  it('strips ▲/▼ glyphs and (±N) deltas — points and model counts stay clean', () => {
    // Hospitaller dropped -10 on both tiers; the parsed values are the new points,
    // and the "-10" delta is never miscounted as a model.
    const hospitaller = sisters.units.find((u) => u.name === 'Hospitaller');
    expect(hospitaller?.supportTo?.length).toBeGreaterThan(0);
    expect(hospitaller?.pricing).toEqual([
      { range: '[1,1]', label: 'Your 1st Unit Costs', costs: [{ models: 1, points: 65 }] },
      { range: '[2,)', label: 'Your 2nd + Unit Costs', costs: [{ models: 1, points: 75 }] },
    ]);
  });

  it('parses a restyled detachment without mistaking its UPDATED note for a UNIQUE banner', () => {
    // "Bringers of Flame" changed: emerald header, a "2DP ▼" badge, and an
    // UPDATED / "FORCE DISPOSITION(S) CHANGED" note whose divs are direct children of
    // the card (the same shape a UNIQUE banner uses).
    const bof = sisters.detachments.find((d) => d.name === 'Bringers of Flame');
    expect(bof?.dp).toBe(2);
    expect(bof?.objectives).toEqual(['PRIORITY ASSETS']);
    expect(bof?.unique).toBeUndefined();
    expect(bof?.enhancements).toContainEqual({ name: 'Fire and Fury', points: 30 });
  });

  it('leaves no annotation chrome anywhere in the parsed output', () => {
    for (const faction of [necrons, sisters]) {
      expect(JSON.stringify(faction)).not.toMatch(MARKER);
    }
  });

  it('strips deltas with a Unicode minus or a thousands separator', () => {
    // `(−10)` uses U+2212, and `(+1,000)` a comma: neither may leak into `models`
    // or cut the points short.
    const html = fixture('adepta-sororitas.html')
      .replaceAll('▼ (-10) 65 pts', '▼ (−10) 65 pts')
      .replaceAll('▼ (-10) 75 pts', '▲ (+1,000) 1,075 pts')
      .replaceAll('▼ (-5) 15 pts', '▲ (+1,005) 1,015 pts');
    const faction = parseFaction(html, 'adepta-sororitas', 'Adepta Sororitas');
    expect(faction.units.find((u) => u.name === 'Hospitaller')?.pricing).toEqual([
      { range: '[1,1]', label: 'Your 1st Unit Costs', costs: [{ models: 1, points: 65 }] },
      { range: '[2,)', label: 'Your 2nd + Unit Costs', costs: [{ models: 1, points: 1075 }] },
    ]);
    const host = faction.detachments.find((d) => d.name === 'Penitent Host');
    expect(host?.enhancements).toContainEqual({
      name: 'Catechism of Divine Penitence',
      points: 1015,
      leaderTo: ['Repentia Squad'],
    });
  });
});

describe('loud failures — content the parser cannot read fails, located', () => {
  it.each([
    ['an en dash', '▼ (–10) 65 pts'],
    ['a sign apart from its number', '▼ (- 10) 65 pts'],
    ['no brackets', '▼ -10 65 pts'],
    ['a plus and no brackets', '▲ +10 65 pts'],
    ['a plus and no glyph', '+10 65 pts'],
    ['a dot separator', '▲ (+1.000) 65 pts'],
  ])('fails on a delta written with %s rather than counting it as models', (_how, cell) => {
    const html = fixture('adepta-sororitas.html').replaceAll('▼ (-10) 65 pts', cell);
    expect(html).not.toBe(fixture('adepta-sororitas.html'));
    expect(() => parseFaction(html, 'adepta-sororitas', 'Adepta Sororitas')).toThrow(
      /"adepta-sororitas", unit "HOSPITALLER": unreadable cost row/,
    );
  });

  it('fails on an unknown change note on a detachment card, naming the card', () => {
    const html = fixture('adepta-sororitas.html').replaceAll(
      'FORCE DISPOSITION(S) CHANGED',
      'DETACHMENT POINTS REVISED',
    );
    const parse = () => parseFaction(html, 'adepta-sororitas', 'Adepta Sororitas');
    expect(parse).toThrow(/Unconsumed content/);
    expect(parse).toThrow(/detachment "BRINGERS OF FLAME": "DETACHMENT POINTS REVISED"/);
  });

  it('fails on an unknown change note on a unit card, naming the card', () => {
    // The UPDATED badge plus a note div, the shape a unit card's note takes.
    const note =
      '<div class="m-0 px-1 py-0.5 bg-slate-300 dark:bg-slate-700 font-bold"><span>UPDATED</span></div>' +
      '<div class="m-0 px-1 py-0.5 bg-slate-200 dark:bg-slate-600 font-bold"><span>UNIT POINTS REVISED</span></div>';
    const anchor = 'CANOPTEK WRAITHS, IMMORTALS, NECRON WARRIORS</span></div>';
    const html = fixture('necrons.html').replace(anchor, anchor + note);
    expect(html).not.toBe(fixture('necrons.html'));
    const parse = () => parseFaction(html, 'necrons', 'Necrons');
    expect(parse).toThrow(/Unconsumed content/);
    expect(parse).toThrow(/unit "TECHNOMANCER": "UNIT POINTS REVISED"/);
  });

  it('fails on an enhancement whose points are not a number, naming faction, detachment and enhancement', () => {
    const html = fixture('adepta-sororitas.html').replace(
      '<span>Fire and Fury</span><span>30 pts</span>',
      '<span>Fire and Fury</span><span>FREE</span>',
    );
    expect(html).not.toBe(fixture('adepta-sororitas.html'));
    const parse = () => parseFaction(html, 'adepta-sororitas', 'Adepta Sororitas');
    expect(parse).toThrow(/"adepta-sororitas"/);
    expect(parse).toThrow(/detachment "BRINGERS OF FLAME"/);
    expect(parse).toThrow(/enhancement "Fire and Fury".*"FREE"/);
  });

  it('fails on a wargear row it cannot read, naming faction, unit and row', () => {
    // The Redemptor's wargear points arrive as a streamed completion.
    const html = fixture('black-templars.html').replace(
      '<div hidden id="S:128"><span>10 pts</span></div>',
      '<div hidden id="S:128"><span>FREE</span></div>',
    );
    expect(html).not.toBe(fixture('black-templars.html'));
    const parse = () => parseFaction(html, 'black-templars', 'Black Templars');
    expect(parse).toThrow(/"black-templars"/);
    expect(parse).toThrow(/unit "REDEMPTOR DREADNOUGHT"/);
    expect(parse).toThrow(/wargear row "per Macro plasma incinerator.*FREE"/);
  });
});
