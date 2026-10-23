import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrossCheck } from './cross-check.js';
import { POINTS_CSV, pointsCsv } from './csv.js';
import { failuresReport, loadFactionDir, RULES_PANELS_FAILURE } from './diff.js';
import {
  contentKey,
  factionFromYaml,
  factionToYaml,
  mapNames,
  metaToYaml,
  type OrderMode,
} from './emit.js';
import { BASE_URL, factionUrl, fetchText, LEGENDS_COOKIE } from './fetch.js';
import { Faction, type FactionContent, SCHEMA_VERSION } from './model.js';
import { parseFaction, parseIndex, type RulesPanels, rulesPanels } from './parse.js';

/**
 * Scrape pipeline: index → faction pages → validated YAML. Run as `pnpm scrape`
 * (`mfm scrape`; its `--help` lists the options, which map onto `ScrapeOptions`).
 *
 * HTTP only, one GET per page. Each faction page is requested with the Legends cookie, so
 * it comes back with its Legends, which `parseFaction` marks `legends: true`; on a full run
 * the rules panels ("Welcome…" notes, "Muster Armies") are decoded from the first faction
 * page's RSC payload for meta.yaml. `--browser` also cross-checks every page against
 * Google Chrome's render (src/cross-check.ts), the one thing that loads a browser.
 *
 * One faction failing does not abort the run; the process exits 1 at the end so CI
 * fails loudly, while still writing the factions that did parse. The rules panels are
 * required too: if they fail, that is reported the same way (as `RULES_PANELS_FAILURE`)
 * and meta.yaml is not written.
 */

/** What to scrape, and where to: `mfm scrape`'s options. */
export interface ScrapeOptions {
  /** One faction's slug; a full run when absent. */
  faction?: string;
  out: string;
  /** Faction pages in flight at once. */
  concurrency: number;
  /** Cross-check every page against Google Chrome's render. */
  browser: boolean;
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

/** An error's message, for the failures report. */
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Run the pipeline; resolves to the exit code (1 when any faction or the panels failed). */
export async function scrape(args: ScrapeOptions): Promise<number> {
  console.log(`Fetching index: ${BASE_URL}`);
  const index = parseIndex(await fetchText(BASE_URL));
  const mode = `HTTP ×${args.concurrency}${args.browser ? ', cross-checked in Chrome' : ''}`;
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
  const fail = (slug: string, err: unknown) => {
    const error = message(err);
    failures.push({ slug, error });
    console.error(`  ✗ ${slug.padEnd(22)} ${error}`);
  };

  // The rules panels are identical across pages, so a full run reads them from the first
  // faction's page, with no request of their own. They are required for meta.yaml.
  const fullRun = !args.faction;
  let panels: RulesPanels | undefined;
  let panelsTried = false;

  // Loaded only for --browser: the scrape itself never touches a browser.
  let check: CrossCheck | undefined;
  try {
    if (args.browser) check = await (await import('./cross-check.js')).openCrossCheck();

    await mapPool(targets, args.concurrency, async (f, i) => {
      try {
        const url = factionUrl(f.slug);
        const html = await fetchText(url, { cookie: LEGENDS_COOKIE });
        if (fullRun && i === 0) {
          panelsTried = true;
          try {
            const decoded = rulesPanels(html);
            await check?.panels(url, decoded);
            panels = decoded;
          } catch (err) {
            fail(RULES_PANELS_FAILURE, err);
          }
        }
        const content = parseFaction(html, f.slug, f.name, knownFactions, { legendsShown: true });
        await check?.faction(url, content, knownFactions);
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
        fail(f.slug, err);
      }
    });
  } finally {
    await check?.close();
  }

  // The page the panels come from never arrived: that is a panels failure too, and, like
  // the page's own, a failed fetch (`isFetchFailure`), not drift.
  if (fullRun && !panelsTried && targets[0]) {
    fail(
      RULES_PANELS_FAILURE,
      `Failed to fetch the page they are read from ("${targets[0].slug}")`,
    );
  }

  // Only rewrite meta on a full run, so a single-faction smoke test stays honest.
  if (fullRun && scraped.length > 0 && panels) {
    const lastUpdated = scraped
      .map((s) => s.firstSeen)
      .sort()
      .at(-1) as string;
    writeFileSync(
      join(args.out, 'meta.yaml'),
      metaToYaml({
        schemaVersion: SCHEMA_VERSION,
        version: index.version,
        lastUpdated,
        ...panels,
        factions: scraped.map((s) => s.slug),
      }),
    );
  }
  // The points table is made from the faction files in --out, so it matches them on every
  // run, a single faction's included.
  writeFileSync(join(args.out, POINTS_CSV), pointsCsv(loadFactionDir(args.out)));

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
