import { launchBrowser, renderFaction, renderRulesPanels } from './browser.js';
import { factionToYaml } from './emit.js';
import type { FactionContent } from './model.js';
import {
  extractMusterMarkdown,
  extractNotesMarkdown,
  markLegends,
  parseFaction,
  RULES_PANELS,
  type RulesPanels,
} from './parse.js';

/**
 * The browser cross-check (`mfm scrape --browser`): what the HTTP scrape read, compared
 * with what Google Chrome shows a visitor. The Legends are found the other way here, by
 * difference between the default render and the one after clicking "Show Legends"
 * (`markLegends`, which also fails if a unit of the default render is missing from the
 * other), and the rules panels are opened by clicking their buttons. A difference throws,
 * naming the first line that differs. See "The browser" in specs/scraping.md.
 */

/** The cross-check, holding Chrome open for the run; `close()` when done. */
export interface CrossCheck {
  /** Throws if the browser's view of the faction page at `url` differs from `http`. */
  faction(url: string, http: FactionContent, knownFactions: ReadonlySet<string>): Promise<void>;
  /** Throws if the panels Chrome opens on the page at `url` differ from `http`. */
  panels(url: string, http: RulesPanels): Promise<void>;
  close(): Promise<void>;
}

/** Run `fn`, once more if it throws: a page load can fail for reasons of its own. */
async function twice<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

/** Throw unless the two texts are equal, naming the first line where they differ. */
export function assertSame(what: string, http: string, browser: string): void {
  if (http === browser) return;
  const a = http.split('\n');
  const b = browser.split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  const n = at === -1 ? a.length : at;
  throw new Error(
    `${what} differs from the HTTP page, from line ${n + 1}: HTTP ${JSON.stringify(a[n] ?? '(end)')}, browser ${JSON.stringify(b[n] ?? '(end)')}`,
  );
}

/** A faction as YAML in page order, the way the cross-check compares it. */
const asYaml = (c: FactionContent): string => factionToYaml({ ...c, firstSeen: '' }, 'page');

/** Start Chrome for a cross-check run. */
export async function openCrossCheck(): Promise<CrossCheck> {
  const browser = await launchBrowser();
  return {
    async faction(url, http, knownFactions) {
      const render = await twice(() => renderFaction(browser, url));
      const parse = (html: string) => parseFaction(html, http.slug, http.name, knownFactions);
      const shown = render.legends
        ? markLegends(parse(render.page), parse(render.legends))
        : parse(render.page);
      assertSame(`"${http.slug}": the browser render`, asYaml(http), asYaml(shown));
    },
    async panels(url, http) {
      const html = await twice(() => renderRulesPanels(browser, url));
      const shown = { notes: extractNotesMarkdown(html), muster: extractMusterMarkdown(html) };
      for (const key of Object.keys(RULES_PANELS) as (keyof RulesPanels)[]) {
        assertSame(`rules panel "${RULES_PANELS[key]}" in the browser`, http[key], shown[key]);
      }
    },
    close: () => browser.close(),
  };
}
