import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import {
  createScrapeContext,
  extractNotes,
  hasLegends,
  launchBrowser,
  renderWithLegends,
} from './browser.js';
import { contentKey, factionFromYaml, factionToYaml, metaToYaml } from './emit.js';
import { BASE_URL, factionUrl, fetchText } from './fetch.js';
import { Faction, type FactionContent } from './model.js';
import { markLegends, parseFaction, parseIndex } from './parse.js';

/**
 * Scrape pipeline: index → faction pages → validated YAML.
 *
 *   pnpm scrape                     # all factions, with Legends (uses a browser)
 *   pnpm scrape --faction necrons   # one faction
 *   pnpm scrape --no-legends        # HTTP-only, skip Legends (fast; no browser)
 *   pnpm scrape --concurrency 6     # faction pages in flight at once (default 4)
 *   pnpm scrape --out /tmp/data     # custom output dir (default: data/)
 *
 * Legends units and the "Welcome…" notes aren't in the server HTML, so capturing
 * them needs a headless browser (Playwright). Without `--no-legends`, each faction
 * page is rendered, "Show Legends" is toggled, and units only present then are
 * flagged `legends: true`. `--no-legends` falls back to plain, faster HTTP.
 *
 * One faction failing does not abort the run; the process exits 1 at the end so CI
 * fails loudly, while still writing the factions that did parse.
 */

interface Args {
  faction?: string;
  out: string;
  concurrency: number;
  legends: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: 'data', concurrency: 4, legends: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--faction') {
      const v = argv[++i];
      if (v !== undefined) args.faction = v;
    } else if (a === '--out') args.out = argv[++i] ?? args.out;
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]) || args.concurrency;
    else if (a === '--no-legends') args.legends = false;
  }
  return args;
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i] as T, i);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * Decide the `firstSeen` date: reuse the existing file's date when the freshly
 * scraped content is identical (so a no-op scrape produces no diff), otherwise
 * stamp `today`.
 */
function resolveFirstSeen(content: FactionContent, outDir: string, today: string): string {
  const path = join(outDir, `${content.slug}.yaml`);
  if (existsSync(path)) {
    try {
      const existing = factionFromYaml(readFileSync(path, 'utf8'));
      if (contentKey(existing) === contentKey(content)) return existing.firstSeen;
    } catch {
      // Unreadable/old-format file → treat as changed and re-stamp.
    }
  }
  return today;
}

/**
 * Fetch + parse one faction. Base data is parsed from plain HTTP (deterministic);
 * if the page ships the Legends toggle and a browser context is available, the
 * Legends are added by rendering the toggled page and diffing.
 */
async function scrapeFaction(
  f: { slug: string; name: string },
  ctx: BrowserContext | null,
): Promise<FactionContent> {
  const url = factionUrl(f.slug);
  const html = await fetchText(url);
  const base = parseFaction(html, f.slug, f.name);
  if (!ctx || !hasLegends(html)) return base;

  // Only Legends factions touch the browser. One retry clears transient nav flakiness.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return markLegends(base, parseFaction(await renderWithLegends(ctx, url), f.slug, f.name));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Fetching index: ${BASE_URL}`);
  const index = parseIndex(await fetchText(BASE_URL));
  const mode = args.legends ? `browser+Legends ×${args.concurrency}` : `HTTP ×${args.concurrency}`;
  console.log(`Site version v${index.version}, ${index.factions.length} factions (${mode})`);

  let targets = index.factions;
  if (args.faction) {
    targets = index.factions.filter((f) => f.slug === args.faction);
    if (targets.length === 0) throw new Error(`Unknown faction slug: ${args.faction}`);
  }

  mkdirSync(args.out, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const scraped: { slug: string; firstSeen: string }[] = [];
  const failures: { slug: string; error: string }[] = [];

  const browser = args.legends ? await launchBrowser() : null;
  const ctx = browser ? await createScrapeContext(browser) : null;
  try {
    // The "Welcome…" notes are identical across pages — grab once for a full run.
    let notes = '';
    if (ctx && !args.faction && targets[0]) {
      notes = await extractNotes(ctx, factionUrl(targets[0].slug)).catch(() => '');
    }

    await mapPool(targets, args.concurrency, async (f) => {
      try {
        const content = await scrapeFaction(f, ctx);
        const firstSeen = resolveFirstSeen(content, args.out, today);
        const faction = Faction.parse({ ...content, firstSeen });
        writeFileSync(join(args.out, `${f.slug}.yaml`), factionToYaml(faction));
        scraped.push({ slug: f.slug, firstSeen });
        const legends = faction.units.filter((u) => u.legends).length;
        const tags = `${legends > 0 ? `, ${legends} legends` : ''}${firstSeen === today ? '  (changed)' : ''}`;
        console.log(
          `  ✓ ${f.slug.padEnd(22)} ${faction.units.length} units, ${faction.detachments.length} detachments${tags}`,
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ slug: f.slug, error });
        console.error(`  ✗ ${f.slug.padEnd(22)} ${error}`);
      }
    });

    // Only rewrite meta on a full run, so a single-faction smoke test stays honest.
    if (!args.faction && scraped.length > 0) {
      const lastUpdated = scraped
        .map((s) => s.firstSeen)
        .sort()
        .at(-1) as string;
      writeFileSync(
        join(args.out, 'meta.yaml'),
        metaToYaml({
          version: index.version,
          lastUpdated,
          ...(notes ? { notes } : {}),
          factions: scraped.map((s) => s.slug),
        }),
      );
    }
  } finally {
    await ctx?.close();
    await browser?.close();
  }

  console.log(`\nDone: ${scraped.length} scraped, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error(`Failures: ${failures.map((x) => x.slug).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
