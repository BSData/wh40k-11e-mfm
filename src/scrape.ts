import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import {
  createScrapeContext,
  hasLegends,
  launchBrowser,
  renderRulesPanels,
  renderWithLegends,
} from './browser.js';
import { failuresReport } from './diff.js';
import {
  contentKey,
  factionFromYaml,
  factionToYaml,
  mapNames,
  metaToYaml,
  type OrderMode,
} from './emit.js';
import { BASE_URL, factionUrl, fetchText } from './fetch.js';
import { Faction, type FactionContent } from './model.js';
import {
  extractMusterMarkdown,
  extractNotesMarkdown,
  markLegends,
  parseFaction,
  parseIndex,
  RULES_PANELS,
} from './parse.js';

/**
 * Scrape pipeline: index → faction pages → validated YAML. Run as `pnpm scrape`
 * (`mfm scrape`; its `--help` lists the options, which map onto `ScrapeOptions`).
 *
 * Legends units and the rules panels ("Welcome…" notes, "Muster Armies") aren't in
 * the server HTML, so capturing them needs a headless browser (Playwright). Without
 * `--no-legends`, each faction page is rendered, "Show Legends" is toggled, and units
 * only present then are flagged `legends: true`, and the rules panels are opened once
 * for meta.yaml. `--no-legends` falls back to plain, faster HTTP.
 *
 * One faction failing does not abort the run; the process exits 1 at the end so CI
 * fails loudly, while still writing the factions that did parse. On a browser run the
 * rules panels are required too: if they fail, that is reported the same way (as
 * `RULES_PANELS_FAILURE`) and meta.yaml is not written.
 */

/** The name the rules panels' failure goes by in the failures report. */
const RULES_PANELS_FAILURE = 'rules panels';

/** What to scrape, and where to: `mfm scrape`'s options. */
export interface ScrapeOptions {
  /** One faction's slug; a full run when absent. */
  faction?: string;
  out: string;
  /** Faction pages in flight at once. */
  concurrency: number;
  /** Render Legends and the rules panels in a browser. */
  legends: boolean;
  order: OrderMode;
  /** Where to write the per-faction failure report, if anywhere. */
  report?: string;
  /** More snapshots to match `firstSeen` against. */
  datesFrom: string[];
  /**
   * Match `firstSeen` ignoring how names are cased, for regenerating `data/` after a
   * change to the Names rule (specs/data-model.md).
   */
  ignoreNameCase: boolean;
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
 * Decide the `firstSeen` date: reuse the date of the *oldest* snapshot whose content
 * matches the freshly scraped one (so a no-op scrape produces no diff), otherwise
 * stamp `today`. `dirs` is the output dir plus any `--dates-from` dirs; the scrape
 * workflow points those at the open update PR's `data/`, so a change that PR already
 * captured keeps the day it was first seen instead of being re-stamped on every run —
 * and a value that reverts to the committed one still resolves to the committed date.
 * With `ignoreNameCase`, names are compared upper-cased, as the site writes them.
 */
function resolveFirstSeen(
  content: FactionContent,
  dirs: string[],
  today: string,
  order: OrderMode,
  ignoreNameCase: boolean,
): string {
  const keyOf = (c: FactionContent) =>
    contentKey(ignoreNameCase ? mapNames(c, (name) => name.toUpperCase()) : c, order);
  const key = keyOf(content);
  const dates: string[] = [];
  for (const dir of dirs) {
    const path = join(dir, `${content.slug}.yaml`);
    if (!existsSync(path)) continue;
    try {
      const existing = factionFromYaml(readFileSync(path, 'utf8'));
      if (keyOf(existing) === key) dates.push(existing.firstSeen);
    } catch {
      // Unreadable/old-format file → treat as changed and re-stamp.
    }
  }
  return dates.length > 0 ? dates.reduce((a, b) => (b < a ? b : a)) : today;
}

/**
 * Fetch + parse one faction. Base data is parsed from plain HTTP (deterministic);
 * if the page ships the Legends toggle and a browser context is available, the
 * Legends are added by rendering the toggled page and diffing.
 */
async function scrapeFaction(
  f: { slug: string; name: string },
  ctx: BrowserContext | null,
  knownFactions: ReadonlySet<string>,
): Promise<FactionContent> {
  const url = factionUrl(f.slug);
  const html = await fetchText(url);
  const base = parseFaction(html, f.slug, f.name, knownFactions);
  if (!ctx || !hasLegends(html)) return base;

  // Only Legends factions touch the browser. One retry clears transient nav flakiness.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return markLegends(
        base,
        parseFaction(await renderWithLegends(ctx, url), f.slug, f.name, knownFactions),
      );
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Render the rules panels and convert them to Markdown for meta.yaml. Throws if the
 * render fails or either panel has no text, after one retry: a run that cannot capture
 * them must fail rather than write a meta.yaml without them.
 */
async function scrapeRulesPanels(
  ctx: BrowserContext,
  url: string,
): Promise<{ notes: string; muster: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await renderRulesPanels(ctx, url);
      const panels = { notes: extractNotesMarkdown(html), muster: extractMusterMarkdown(html) };
      const empty = (Object.keys(RULES_PANELS) as (keyof typeof RULES_PANELS)[]).filter(
        (key) => !panels[key],
      );
      if (empty.length === 0) return panels;
      throw new Error(
        `no text in rules panel ${empty.map((key) => `"${RULES_PANELS[key]}"`).join(', ')}`,
      );
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Run the pipeline; resolves to the exit code (1 when any faction or the panels failed). */
export async function scrape(args: ScrapeOptions): Promise<number> {
  console.log(`Fetching index: ${BASE_URL}`);
  const index = parseIndex(await fetchText(BASE_URL));
  const mode = args.legends ? `browser+Legends ×${args.concurrency}` : `HTTP ×${args.concurrency}`;
  console.log(`Site version v${index.version}, ${index.factions.length} factions (${mode})`);

  let targets = index.factions;
  if (args.faction) {
    targets = index.factions.filter((f) => f.slug === args.faction);
    if (targets.length === 0) throw new Error(`Unknown faction slug: ${args.faction}`);
  }

  // All faction names (lower-cased) — lets the parser tell a genuine parent-army title
  // (names another faction) from a same-shaped sub-army/army-rule heading. Built from the
  // full index, not `targets`, so a single-faction run still recognizes its parent.
  const knownFactions = new Set(index.factions.map((f) => f.name.toLowerCase()));

  mkdirSync(args.out, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const scraped: { slug: string; firstSeen: string }[] = [];
  const failures: { slug: string; error: string }[] = [];

  const browser = args.legends ? await launchBrowser() : null;
  let ctx: BrowserContext | null = null;
  try {
    // Inside the `try`, so a context that fails to open still closes the browser: a
    // browser left running would keep the process from exiting.
    ctx = browser ? await createScrapeContext(browser) : null;
    // The rules panels are identical across pages — render them once for a full run.
    // A browser run needs them: if they fail, meta.yaml is left as it is.
    let panels: { notes: string; muster: string } | undefined;
    let panelsFailed = false;
    if (ctx && !args.faction && targets[0]) {
      try {
        panels = await scrapeRulesPanels(ctx, factionUrl(targets[0].slug));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ slug: RULES_PANELS_FAILURE, error });
        panelsFailed = true;
        console.error(`  ✗ ${RULES_PANELS_FAILURE.padEnd(22)} ${error}`);
      }
    }

    await mapPool(targets, args.concurrency, async (f) => {
      try {
        const content = await scrapeFaction(f, ctx, knownFactions);
        const firstSeen = resolveFirstSeen(
          content,
          [args.out, ...args.datesFrom],
          today,
          args.order,
          args.ignoreNameCase,
        );
        const faction = Faction.parse({ ...content, firstSeen });
        writeFileSync(join(args.out, `${f.slug}.yaml`), factionToYaml(faction, args.order));
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
    if (!args.faction && scraped.length > 0 && !panelsFailed) {
      const lastUpdated = scraped
        .map((s) => s.firstSeen)
        .sort()
        .at(-1) as string;
      writeFileSync(
        join(args.out, 'meta.yaml'),
        metaToYaml({
          version: index.version,
          lastUpdated,
          ...panels,
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
    // Persist a located, per-faction report for the workflow's error issue. Written
    // before exit so it survives the non-zero exit that triggers the issue step.
    if (args.report) writeFileSync(args.report, failuresReport(failures));
    return 1;
  }
  return 0;
}
