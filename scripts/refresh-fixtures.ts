import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createScrapeContext,
  launchBrowser,
  renderRulesPanels,
  renderWithLegends,
} from '../src/browser.js';
import { BASE_URL, factionUrl, fetchText, sleep } from '../src/fetch.js';

/**
 * Re-downloads the HTML fixtures the parser tests run against. Run this when the
 * source site changes and a test needs to be re-baselined:
 *
 *   pnpm refresh-fixtures
 *   pnpm refresh-fixtures --only space-marines.html   # just the named fixture(s)
 *
 * Keep the fixture set small and representative — it exists to pin parser
 * behaviour, not to mirror the whole site. `necrons` covers simple units,
 * multi-model-count units, per-instance tiered pricing, and detachments.
 *
 * `--only <name>` (repeatable) fetches just those fixtures and leaves the rest as they
 * are — use it to add a fixture without re-baselining the others.
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
  // space-marines (v1.6): the v1.4 structures — a unit with both a Leader and a Support
  // list (Cato Sicarius) and detachments granting two Force Dispositions.
  { name: 'space-marines.html', url: factionUrl('space-marines') },
];

// Browser renders: necrons-legends (legends toggled on) pins legends detection;
// necrons-panels (both rules panels open) pins the notes/muster Markdown.
const RENDERS = [
  ['necrons-legends.html', renderWithLegends],
  ['necrons-panels.html', renderRulesPanels],
] as const;

const only = process.argv.flatMap((a, i, all) => (all[i - 1] === '--only' ? [a] : []));
const wanted = (name: string) => only.length === 0 || only.includes(name);
const known = [...FIXTURES.map((fx) => fx.name), ...RENDERS.map(([name]) => name)];
const unknown = only.filter((name) => !known.includes(name));
if (unknown.length > 0) throw new Error(`Unknown fixture(s): ${unknown.join(', ')}`);

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

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
  const ctx = await createScrapeContext(browser);
  try {
    for (const [name, render] of renders) {
      const html = await render(ctx, factionUrl('necrons'));
      writeFileSync(join(dir, name), html);
      console.log(`saved ${name} (${html.length} bytes, browser render)`);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }
}

console.log('Done. Review the diff and update snapshots with: pnpm test -u');
