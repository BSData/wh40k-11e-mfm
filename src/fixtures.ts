import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from 'playwright';
import {
  createScrapeContext,
  launchBrowser,
  renderRulesPanels,
  renderWithLegends,
} from './browser.js';
import { BASE_URL, factionUrl, fetchText, sleep } from './fetch.js';

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

export const FIXTURES: { name: string; url: string }[] = [
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
];

// Browser renders: necrons-legends (legends toggled on) pins legends detection;
// necrons-panels (both rules panels open) pins the notes/muster Markdown.
export const RENDERS = [
  ['necrons-legends.html', renderWithLegends],
  ['necrons-panels.html', renderRulesPanels],
] as const;

/** Where the fixtures live: `test/fixtures/`. */
export const FIXTURES_DIR = fileURLToPath(new URL('../test/fixtures', import.meta.url));

/**
 * Download the fixtures named in `only` (every one when empty) into `dir`. Throws on a
 * name that isn't a fixture, before downloading anything: a typo must not fall back to
 * refreshing everything (which would overwrite the annotated adepta-sororitas.html, no
 * longer reproducible from the live site).
 */
export async function refreshFixtures(only: readonly string[], dir = FIXTURES_DIR): Promise<void> {
  const wanted = (name: string) => only.length === 0 || only.includes(name);
  const known = [...FIXTURES.map((fx) => fx.name), ...RENDERS.map(([name]) => name)];
  const unknown = only.filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown fixture(s): ${unknown.join(', ')}`);

  mkdirSync(dir, { recursive: true });
  for (const [i, fx] of FIXTURES.filter((fx) => wanted(fx.name)).entries()) {
    if (i > 0) await sleep(750);
    const html = await fetchText(fx.url);
    writeFileSync(join(dir, fx.name), html);
    console.log(`saved ${fx.name} (${html.length} bytes) from ${fx.url}`);
  }

  const renders = RENDERS.filter(([name]) => wanted(name));
  if (renders.length > 0) {
    const browser = await launchBrowser();
    let ctx: BrowserContext | undefined;
    try {
      // Inside the `try`, so a context that fails to open still closes the browser.
      ctx = await createScrapeContext(browser);
      for (const [name, render] of renders) {
        const html = await render(ctx, factionUrl('necrons'));
        writeFileSync(join(dir, name), html);
        console.log(`saved ${name} (${html.length} bytes, browser render)`);
      }
    } finally {
      await ctx?.close();
      await browser.close();
    }
  }

  console.log('Done. Review the diff and update snapshots with: pnpm test -u');
}
