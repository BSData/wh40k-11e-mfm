import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScrapeContext, launchBrowser, renderWithLegends } from '../src/browser.js';
import { BASE_URL, factionUrl, fetchText, sleep } from '../src/fetch.js';

/**
 * Re-downloads the HTML fixtures the parser tests run against. Run this when the
 * source site changes and a test needs to be re-baselined:
 *
 *   pnpm refresh-fixtures
 *
 * Keep the fixture set small and representative — it exists to pin parser
 * behaviour, not to mirror the whole site. `necrons` covers simple units,
 * multi-model-count units, per-instance tiered pricing, and detachments.
 */

const FIXTURES: { name: string; url: string }[] = [
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
];

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

mkdirSync(dir, { recursive: true });
for (const [i, fx] of FIXTURES.entries()) {
  if (i > 0) await sleep(750);
  const html = await fetchText(fx.url);
  writeFileSync(join(dir, fx.name), html);
  console.log(`saved ${fx.name} (${html.length} bytes) from ${fx.url}`);
}

// necrons-legends: the legends-on render (browser) — pins legends detection.
const browser = await launchBrowser();
const ctx = await createScrapeContext(browser);
try {
  const full = await renderWithLegends(ctx, factionUrl('necrons'));
  writeFileSync(join(dir, 'necrons-legends.html'), full);
  console.log(`saved necrons-legends.html (${full.length} bytes, browser render)`);
} finally {
  await ctx.close();
  await browser.close();
}

console.log('Done. Review the diff and update snapshots with: pnpm test -u');
