import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { launchBrowser, renderFaction, renderRulesPanels } from './browser.js';
import { BASE_URL, factionUrl, fetchText, LEGENDS_COOKIE, sleep } from './fetch.js';

/**
 * The HTML fixtures the parser tests run against, and re-downloading them
 * (`pnpm refresh-fixtures`, which is `mfm refresh-fixtures`). Run it when the source site
 * changes and a test needs to be re-baselined; `--only <name>` (repeatable) fetches just
 * those fixtures and leaves the rest as they are, to add one without re-baselining the
 * others.
 *
 * Keep the fixture set small and representative — it exists to pin parser
 * behaviour, not to mirror the whole site. `necrons` covers simple units,
 * multi-model-count units, per-instance tiered pricing, and detachments.
 */

export const FIXTURES: { name: string; url: string; cookie?: string }[] = [
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
  // necrons-panels (both rules panels open) pins the notes/muster Markdown.
  { name: 'necrons-panels.html', render: renderRulesPanels },
];

/** Where the fixtures live: `test/fixtures/`. */
export const FIXTURES_DIR = fileURLToPath(new URL('../test/fixtures', import.meta.url));

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

  mkdirSync(dir, { recursive: true });
  for (const [i, fx] of FIXTURES.filter((fx) => wanted(fx.name)).entries()) {
    if (i > 0) await sleep(750);
    const html = await fetchText(fx.url, fx.cookie ? { cookie: fx.cookie } : {});
    writeFileSync(join(dir, fx.name), html);
    console.log(`saved ${fx.name} (${html.length} bytes) from ${fx.url}`);
  }

  const renders = RENDERS.filter((r) => wanted(r.name));
  if (renders.length > 0) {
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
