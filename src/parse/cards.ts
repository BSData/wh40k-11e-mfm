import type { CheerioAPI } from 'cheerio';
import { ENHANCEMENTS_LABEL, UNIT_BLOCK_LABELS } from '../allowlists.js';
import type { Detachment, PricingTier, Unit, Wargear } from '../model.js';
import { nameCase, titleCase } from './names.js';
import { cardName, cardWhere, DELTA_MARKER_RE, TIER_LABEL_SELECTOR } from './page.js';
import { clean } from './text.js';
import { DP_RE, parseCostRow, parsePoints, parseRange, UNIQUE_RE } from './values.js';

/**
 * A unit or detachment card, parsed whole. Each parser pushes onto `consumed` the exact
 * text of every element it turned into data, for the coverage check.
 */

/**
 * Parse the unit's role blocks (icon + comma-separated attach list) into one list per
 * ability. A unit may carry a Leader block, a Support block, or **both** with different
 * lists — v1.4's Judiciar leads twelve units and supports five — so this returns them
 * keyed by ability rather than picking a single role. Two blocks of the *same* ability
 * have never appeared and would be a genuine surprise, so that still throws. A block's
 * label is consumed with its list, and only if it reads as `UNIT_BLOCK_LABELS` lists it.
 */
function parseRole(
  card: ReturnType<CheerioAPI>,
  where: string,
  consumed: string[],
): Pick<Unit, 'leaderTo' | 'supportTo'> {
  const out: Pick<Unit, 'leaderTo' | 'supportTo'> = {};
  const imgs = card.find('img[src$="leader.svg"], img[src$="support.svg"]');
  imgs.each((_i, el) => {
    const img = card.find(el);
    const key = (img.attr('src') ?? '').includes('leader') ? 'leaderTo' : 'supportTo';
    if (out[key]) throw new Error(`${where}: unexpected repeated ${key} block`);
    const list = clean(img.parent().nextAll('span').first().text());
    const attachTo = list
      .split(',')
      .map((s) => nameCase(s))
      .filter(Boolean);
    if (attachTo.length > 0) {
      out[key] = attachTo;
      consumed.push(list);
      const label = clean(img.parent().text());
      if (label === UNIT_BLOCK_LABELS[key]) consumed.push(label);
    }
  });
  return out;
}

/**
 * Parse the "Wargear Options" block (cog icon + per-item costs), if present. Its label is
 * consumed with its rows, and only if it reads as `UNIT_BLOCK_LABELS.wargear`.
 */
function parseWargear(
  $: CheerioAPI,
  card: ReturnType<CheerioAPI>,
  where: string,
  consumed: string[],
): Wargear[] {
  const cog = card.find('img[src$="cog.svg"]').first();
  if (cog.length === 0) return [];
  const wargear = cog
    .parent()
    .parent()
    .find('ul li')
    .map((_i, li) => {
      const spans = $(li).find('span');
      const itemText = clean(spans.first().text());
      const pointsText = spans.length > 1 ? clean(spans.last().text()) : '';
      const item = itemText.replace(/^per\s+/i, '');
      const points = parsePoints(pointsText.replace(DELTA_MARKER_RE, ''));
      if (!item || points === null) {
        const row = spans.map((_j, s) => clean($(s).text())).get();
        throw new Error(
          `${where}: unreadable wargear row "${row.join(' ') || clean($(li).text())}"`,
        );
      }
      consumed.push(itemText, pointsText);
      return { item, points };
    })
    .get();
  const label = clean(cog.parent().text());
  if (wargear.length > 0 && label === UNIT_BLOCK_LABELS.wargear) consumed.push(label);
  return wargear;
}

export function parseUnit(
  $: CheerioAPI,
  card: ReturnType<CheerioAPI>,
  slug: string,
  consumed: string[],
): Unit {
  const where = cardWhere(slug, 'unit', card);
  const name = nameCase(cardName(card));
  consumed.push(cardName(card));
  const pricing: PricingTier[] = [];

  // Each tier = a `div.bg-slate-200` label followed by a `ul.leaders` of rows. The
  // role block's `div.bg-slate-200` label (LEADER/SUPPORT) has no `ul.leaders`, so
  // it contributes no costs and is skipped here; `parseRole` consumes it with its list.
  card.find(TIER_LABEL_SELECTOR).each((_, labelEl) => {
    const labelText = clean($(labelEl).text());
    const label = titleCase(labelText);
    const ul = $(labelEl).nextAll('ul.leaders').first();
    const costs = ul
      .find('li')
      .map((_i, li) => {
        const row = clean($(li).text());
        const cost = parseCostRow(where, row);
        consumed.push(row);
        return cost;
      })
      .get();
    if (costs.length > 0) {
      pricing.push({ range: parseRange(label), label, costs });
      consumed.push(labelText);
    }
  });

  if (pricing.length === 0) throw new Error(`${where}: no pricing tiers`);
  const wargear = parseWargear($, card, where, consumed);
  return {
    name,
    pricing,
    ...parseRole(card, where, consumed),
    ...(wargear.length > 0 ? { wargear } : {}),
  };
}

// What follows an enhancement's <li> and belongs to it: its sibling <div> in the old
// per-enhancement wrapper, or the `li.no-leaders` rows after it in the flat list.
function grantBlocks(li: ReturnType<CheerioAPI>) {
  return li.nextUntil('li:not(.no-leaders)');
}

/** Units a detachment enhancement grants an ability to via a "LEADER:"/"SUPPORT:" block. */
function enhancementGrant(
  $: CheerioAPI,
  li: ReturnType<CheerioAPI>,
  keyword: 'LEADER:' | 'SUPPORT:',
  consumed: string[],
): string[] {
  const list = clean(
    grantBlocks(li)
      .find('span')
      .filter((_j, s) => clean($(s).text()) === keyword)
      .first()
      .nextAll('span')
      .first()
      .text(),
  );
  const units = list
    .split(',')
    .map((s) => nameCase(s))
    .filter(Boolean);
  if (units.length > 0) consumed.push(keyword, list);
  return units;
}

export function parseDetachment(
  $: CheerioAPI,
  card: ReturnType<CheerioAPI>,
  slug: string,
  consumed: string[],
): Detachment {
  const where = cardWhere(slug, 'detachment', card);
  const header = card.children().first();
  const name = nameCase(cardName(card));
  consumed.push(cardName(card));
  // A badge that isn't a whole "NDP" is left unconsumed, so the coverage check reports it.
  const dpText = clean(header.find('span.self-end').last().text());
  const dpMatch = dpText.match(DP_RE);
  if (dpMatch) consumed.push(dpText);
  const dp = dpMatch ? Number.parseInt(dpMatch[1] as string, 10) : null;
  // Force Dispositions are the styled banner divs directly under the header — plural
  // since v1.4, where Orks' WAR HORDE grants both TAKE AND HOLD and PURGE THE FOE.
  const objectives = card
    .children('div[style]')
    .map((_i, el) => clean($(el).text()))
    .get()
    .filter(Boolean);
  consumed.push(...objectives);
  // "UNIQUE: X" restriction banner — a direct-child slate-200 div (same class units
  // use for tier labels, here repurposed). Match on the literal prefix so the change
  // badge/note divs (also direct children) are never mistaken for it.
  const banner = clean(
    card
      .children('div.bg-slate-200')
      .filter((_j, el) => UNIQUE_RE.test(clean($(el).text())))
      .first()
      .text(),
  );
  const unique = nameCase(banner.replace(UNIQUE_RE, ''));
  if (unique) consumed.push(banner);
  const enhancements = card
    .find('ul.leaders li:not(.no-leaders)')
    .map((_i, el) => {
      const li = $(el);
      const spans = li.find('div').last().find('span');
      const enhName = clean(spans.first().text());
      const pointsText = spans.length > 1 ? clean(spans.last().text()) : '';
      const points = parsePoints(pointsText);
      if (!enhName) throw new Error(`${where}: unreadable enhancement row "${clean(li.text())}"`);
      if (points === null) {
        throw new Error(`${where}: enhancement "${enhName}" has unreadable points "${pointsText}"`);
      }
      consumed.push(enhName, pointsText);
      // A "LEADER:"/"SUPPORT:" block sits beside the enhancement it belongs to (a
      // sibling of the <li> in the same wrapper): buying it unlocks those units.
      const leaderTo = enhancementGrant($, li, 'LEADER:', consumed);
      const supportTo = enhancementGrant($, li, 'SUPPORT:', consumed);
      return {
        name: enhName,
        points,
        ...(leaderTo.length > 0 ? { leaderTo } : {}),
        ...(supportTo.length > 0 ? { supportTo } : {}),
      };
    })
    .get();
  // The `ENHANCEMENTS` heading right before the list, consumed with the list it heads.
  const heading = clean(card.find('ul.leaders').first().prev().text());
  if (enhancements.length > 0 && heading === ENHANCEMENTS_LABEL) consumed.push(heading);

  return { name, dp, objectives, ...(unique ? { unique } : {}), enhancements };
}
