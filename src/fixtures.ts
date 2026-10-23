import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { launchBrowser, renderFaction, renderRulesPanels } from './browser.js';
import { RULES_PANELS_FAILURE, readFailuresReport } from './diff/failures.js';
import { BASE_URL, factionUrl, fetchText, isFetchFailure, LEGENDS_COOKIE, sleep } from './fetch.js';

/**
 * The HTML fixtures the parser tests run against, and re-downloading them
 * (`pnpm refresh-fixtures`, which is `mfm refresh-fixtures`). Run it when the source site
 * changes and a test needs to be re-baselined; `--only <name>` (repeatable) fetches just
 * those fixtures and leaves the rest as they are, to add one without re-baselining the
 * others. `--failed <report>` picks the pages a failed scrape names instead, for the drift
 * fixer (`fixturesForFailures`).
 *
 * Keep the fixture set small and representative — it exists to pin parser
 * behaviour, not to mirror the whole site. `necrons` covers simple units,
 * multi-model-count units, per-instance tiered pricing, and detachments.
 */

/** A page saved for the tests: its file name under `test/fixtures/`, and how it is fetched. */
export interface Fixture {
  name: string;
  url: string;
  cookie?: string;
}

export const FIXTURES: Fixture[] = [
  { name: 'index.html', url: BASE_URL },
  // necrons: simple units, multi-model counts, per-instance tiered pricing.
  { name: 'necrons.html', url: factionUrl('necrons') },
  // black-templars: fully-streamed cards + composite size rows
  // ("1 Sword Brother, 4 Neophytes, 5 Initiates") + "+ 1 Invader ATV" add-on.
  { name: 'black-templars.html', url: factionUrl('black-templars') },
  // titan-legions: thousands-separator points ("2,200 pts").
  { name: 'titan-legions.html', url: factionUrl('titan-legions') },
  // adepta-sororitas: the "changed since last MFM" annotation layer — restyled unit
  // and detachment headers (▲/▼, coloured), (±N) cost deltas, UPDATED/note badges.
  { name: 'adepta-sororitas.html', url: factionUrl('adepta-sororitas') },
  // space-marines (v1.6): the v1.4 structures — a unit with both a Leader and a Support
  // list (Cato Sicarius) and detachments granting two Force Dispositions.
  { name: 'space-marines.html', url: factionUrl('space-marines') },
  // adeptus-custodes (v1.6): the "WARGEAR COSTS REMOVED" change note.
  { name: 'adeptus-custodes.html', url: factionUrl('adeptus-custodes') },
  // necrons-legends-cookie (v1.6): fetched with the Legends cookie, as the scrape fetches
  // every page — the Legends server-rendered under a LEGENDS section heading.
  { name: 'necrons-legends-cookie.html', url: factionUrl('necrons'), cookie: LEGENDS_COOKIE },
  // necrons-panels-rsc (v1.6): a plain GET, whose RSC payload carries the rules panels
  // that necrons-panels.html shows opened in a browser.
  { name: 'necrons-panels-rsc.html', url: factionUrl('necrons') },
];

/** The browser renders, made with Google Chrome (src/browser.ts). */
export const RENDERS: { name: string; render(browser: Browser, url: string): Promise<string> }[] = [
  // necrons-legends (legends toggled on) pins Legends detection by difference.
  {
    name: 'necrons-legends.html',
    async render(browser, url) {
      const { legends } = await renderFaction(browser, url);
      if (legends === undefined) throw new Error(`${url} has no Legends toggle`);
      return legends;
    },
  },
  // necrons-panels (both rules panels open) pins the notes/muster Markdown. It shows the
  // Legends too: the tests use it as the v1.6 render after "Show Legends" was clicked.
  {
    name: 'necrons-panels.html',
    render: (browser, url) => renderRulesPanels(browser, url, { legends: true }),
  },
];

/** Where the fixtures live: `test/fixtures/`. */
export const FIXTURES_DIR = fileURLToPath(new URL('../test/fixtures', import.meta.url));

/** The fixture that holds the rules panels as the scrape reads them (a plain page's payload). */
const PANELS_FIXTURE = 'necrons-panels-rsc.html';

/**
 * The pages that show why a scrape failed, from its failures report (`pnpm scrape
 * --report`), for the drift fixer: each failed faction's fixtures, or its page as the
 * scrape fetches it (with the Legends cookie, saved as `<slug>-legends-cookie.html`, the
 * name the add-fixture skill gives one) when no fixture covers it, and `PANELS_FIXTURE` for
 * the rules panels. A failure to fetch a page is an outage, not drift, so it picks nothing.
 * Over HTTP only: no browser renders. Throws on a heading that is not a faction's slug,
 * since the slugs come from the site.
 */
export function fixturesForFailures(report: string): Fixture[] {
  const picked = new Map<string, Fixture>();
  const pick = (fx: Fixture) => picked.set(fx.name, fx);
  for (const { slug, error } of readFailuresReport(report)) {
    if (isFetchFailure(error)) continue;
    if (slug === RULES_PANELS_FAILURE) {
      FIXTURES.filter((fx) => fx.name === PANELS_FIXTURE).forEach(pick);
      continue;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`Not a faction slug in the failure report: ${JSON.stringify(slug)}`);
    }
    const own = FIXTURES.filter((fx) => fx.url === factionUrl(slug));
    if (own.length > 0) own.forEach(pick);
    else
      pick({ name: `${slug}-legends-cookie.html`, url: factionUrl(slug), cookie: LEGENDS_COOKIE });
  }
  return [...picked.values()];
}

/**
 * Download `fixtures` over HTTP, one at a time, then save them all into `dir`: a run that
 * fails part-way saves nothing. Returns how many were saved.
 */
export async function downloadFixtures(fixtures: readonly Fixture[], dir: string): Promise<number> {
  const pages: { fx: Fixture; html: string }[] = [];
  for (const [i, fx] of fixtures.entries()) {
    if (i > 0) await sleep(750);
    pages.push({ fx, html: await fetchText(fx.url, fx.cookie ? { cookie: fx.cookie } : {}) });
  }
  if (pages.length > 0) mkdirSync(dir, { recursive: true });
  for (const { fx, html } of pages) {
    writeFileSync(join(dir, fx.name), html);
    console.log(`saved ${fx.name} (${html.length} bytes) from ${fx.url}`);
  }
  return pages.length;
}

/**
 * Download the fixtures named in `only` (every one when empty) into `dir`. Throws on a
 * name that isn't a fixture, before downloading anything: a typo must not fall back to
 * refreshing everything (which would overwrite the annotated adepta-sororitas.html, no
 * longer reproducible from the live site). Only the browser renders start Chrome.
 */
export async function refreshFixtures(only: readonly string[], dir = FIXTURES_DIR): Promise<void> {
  const wanted = (name: string) => only.length === 0 || only.includes(name);
  const known = [...FIXTURES.map((fx) => fx.name), ...RENDERS.map((r) => r.name)];
  const unknown = only.filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown fixture(s): ${unknown.join(', ')}`);

  await downloadFixtures(
    FIXTURES.filter((fx) => wanted(fx.name)),
    dir,
  );

  const renders = RENDERS.filter((r) => wanted(r.name));
  if (renders.length > 0) {
    mkdirSync(dir, { recursive: true });
    const browser = await launchBrowser();
    try {
      for (const { name, render } of renders) {
        const html = await render(browser, factionUrl('necrons'));
        writeFileSync(join(dir, name), html);
        console.log(`saved ${name} (${html.length} bytes, browser render)`);
      }
    } finally {
      await browser.close();
    }
  }

  console.log('Done. Review the diff and update snapshots with: pnpm test -u');
}
