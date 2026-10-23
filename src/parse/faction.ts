import { load } from 'cheerio';
import type { Detachment, FactionContent, SiteIndex, Unit } from '../model.js';
import { parseDetachment, parseUnit } from './cards.js';
import { assertFactionCovered } from './coverage.js';
import { nameCase } from './names.js';
import { CARD_SELECTOR, deannotate, hydrate, isUnitCard, topCards } from './page.js';
import { clean } from './text.js';
import { parseVersion } from './values.js';

/** A faction page and the index page, parsed; and the Legends found by difference. */

/** The section heading the Legends units sit under, when the page shows them. */
const LEGENDS_SECTION = 'LEGENDS';

/** The "Show Legends" toggle, which the server ships only for factions that have Legends. */
const LEGENDS_TOGGLE = 'input#show-legends';

/** How the page was requested. */
export interface PageOptions {
  /**
   * Sent with the Legends cookie (`isLegendsDisplayed=true`), so a page that ships the
   * Legends toggle must show a `LEGENDS` section: without one, the cookie didn't work.
   */
  legendsShown?: boolean;
}

/**
 * Parse a faction subpage. `name`/`slug` come from the index (clean display name).
 * `knownFactions` is the set of all faction display names (lower-cased) used to tell a
 * genuine parent-army title from a same-shaped sub-army/army-rule heading. Units under the
 * `LEGENDS` section heading get `legends: true`.
 */
export function parseFaction(
  html: string,
  slug: string,
  name: string,
  knownFactions: ReadonlySet<string> = new Set(),
  { legendsShown = false }: PageOptions = {},
): FactionContent {
  const $ = load(html);
  const version = parseVersion($);
  hydrate($);
  deannotate($);

  // Units are partitioned into a base roster (directly under the UNITS section) plus
  // named sub-groups introduced by army-group headers — `h3.font-header` *without* the
  // section break-after class — e.g. "Harlequins"/"Ynnari" on Aeldari, a Chapter on
  // Space Marines, the shared "Space Marines" roster on a successor chapter. Walk the
  // headers and cards in document order so each unit picks up the sub-group it sits
  // under; a section header (UNITS/DETACHMENTS/LEGENDS) resets back to the base roster.
  // The same walk marks the units of the LEGENDS section.
  const groupTitles: string[] = [];
  const groupByCard = new Map<unknown, string | undefined>();
  const legendsCards = new Set<unknown>();
  let currentGroup: string | undefined;
  let section: string | undefined;
  let hasLegendsSection = false;
  $(`h3.font-header, ${CARD_SELECTOR}`).each((_i, el) => {
    if ((el as { tagName?: string }).tagName === 'h3') {
      const isSection = ($(el).attr('class') ?? '').includes('break-after');
      if (isSection) section = clean($(el).text());
      if (section === LEGENDS_SECTION) hasLegendsSection = true;
      currentGroup = isSection ? undefined : nameCase($(el).text());
      if (currentGroup) groupTitles.push(currentGroup);
    } else if (isUnitCard($, $(el))) {
      groupByCard.set(el, currentGroup);
      if (section === LEGENDS_SECTION) legendsCards.add(el);
    }
  });
  if (legendsShown && !hasLegendsSection && $(LEGENDS_TOGGLE).length > 0) {
    throw new Error(
      `"${slug}": the page has the Legends toggle but no ${LEGENDS_SECTION} section, so the ` +
        'Legends cookie (isLegendsDisplayed=true) no longer shows them',
    );
  }

  // Each card is a unit or a detachment; parse it whole, in document order, keeping
  // the strings each card's parse consumed for the coverage check.
  const units: Unit[] = [];
  const detachments: Detachment[] = [];
  const consumed = new Map<unknown, string[]>();
  topCards($).each((_i, el) => {
    const card = $(el);
    const seen: string[] = [];
    consumed.set(el, seen);
    if (isUnitCard($, card)) {
      const unit = parseUnit($, card, slug, seen);
      const group = groupByCard.get(el);
      units.push({
        ...unit,
        ...(group ? { groupTitle: group } : {}),
        ...(legendsCards.has(el) ? { legends: true as const } : {}),
      });
    } else {
      detachments.push(parseDetachment($, card, slug, seen));
    }
  });
  if (units.length === 0) {
    throw new Error(`No units found for "${slug}" — the card/name selector may have drifted`);
  }
  if (units.every((u) => u.legends)) {
    throw new Error(
      `"${slug}": every unit is in the ${LEGENDS_SECTION} section, so the base roster is missing`,
    );
  }

  // A sub-group header that names *another* known faction marks this as that faction's
  // successor (e.g. "Space Marines" for Black Templars). Surfaced at the faction level as
  // `parent`; the units in that group also carry it as their `groupTitle`. Non-faction
  // sub-group headers (e.g. "Harlequins") live only on the units, not here.
  const parent = groupTitles.find(
    (t) => t.toLowerCase() !== name.toLowerCase() && knownFactions.has(t.toLowerCase()),
  );

  // Last: prove we left nothing on the page unread (mutates $).
  assertFactionCovered($, slug, name, version, consumed);

  return { slug, name, version, ...(parent ? { parent } : {}), detachments, units };
}

/**
 * Each unit's identity on its page: sub-group + name + which unit of that name in that
 * sub-group it is, in page order — a page can list two units of the same name.
 */
function unitKeys(units: readonly Unit[]): string[] {
  const seen = new Map<string, number>();
  return units.map((u) => {
    const id = u.groupTitle ? `${u.groupTitle} / ${u.name}` : u.name;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return `${id} (#${n})`;
  });
}

/**
 * Find the Legends by difference, as the browser cross-check does: the units of the
 * Legends-on render (`full`) that the default render (`base`) doesn't have, matching units
 * by `unitKeys`. Both are parser output of the same faction. Returns `full` with
 * `legends: true` on exactly those units, whatever section they sit in, so the result
 * doesn't lean on the `LEGENDS` section that `parseFaction` marks by. Throws if a base unit
 * is missing from `full`, rather than dropping it.
 */
export function markLegends(base: FactionContent, full: FactionContent): FactionContent {
  const baseKeys = unitKeys(base.units);
  const fullKeys = unitKeys(full.units);
  const inFull = new Set(fullKeys);
  const missing = baseKeys.filter((k) => !inFull.has(k));
  if (missing.length > 0) {
    throw new Error(
      `"${base.slug}": base units missing from the Legends render: ${missing.join(', ')}`,
    );
  }
  const inBase = new Set(baseKeys);
  return {
    ...full,
    units: full.units.map(({ legends, ...u }, i) =>
      inBase.has(fullKeys[i] as string) ? u : { ...u, legends: true },
    ),
  };
}

/** Parse the landing page into the site version and the list of faction subpages. */
export function parseIndex(html: string): SiteIndex {
  const $ = load(html);
  const version = parseVersion($);
  const seen = new Map<string, string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/^\/en\/([a-z0-9-]+)$/);
    if (!m) return;
    const slug = m[1] as string;
    const text = clean($(el).text());
    if (text && !seen.has(slug)) seen.set(slug, text);
  });
  if (seen.size === 0) throw new Error('No faction links found on the index page');
  const factions = [...seen.entries()].map(([slug, name]) => ({ slug, name }));
  return { version, factions };
}
