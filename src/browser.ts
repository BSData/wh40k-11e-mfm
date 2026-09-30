import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { RULES_PANELS } from './parse.js';

/**
 * Headless-browser access for the bits that aren't in the server HTML:
 *  - Legends units (revealed by the client-only "Show Legends" toggle), and
 *  - the collapsible rules panels ("Welcome…" notes and "Muster Armies").
 *
 * Everything else is scraped over plain HTTP; this module is used only when
 * legends/rules panels are wanted. Pages are rendered, so the resulting HTML is already
 * hydrated — `parseFaction` runs on it unchanged (its template-hydration no-ops).
 *
 * Use one context (`createScrapeContext`) for the whole run: declining cookies
 * once persists, and image/font/media requests are blocked so pages settle fast.
 */

const UNIT_SELECTOR = 'div.bg-slate-500.text-xl';
const LEGENDS_TOGGLE = '#show-legends-label';
const NAV_TIMEOUT = 45_000;
const ACTION_TIMEOUT = 15_000;
const BLOCKED = new Set(['image', 'font', 'media']);

export const launchBrowser = (): Promise<Browser> => chromium.launch();

/** A context that blocks heavy assets — we only need the rendered HTML/text. */
export async function createScrapeContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.route('**/*', (route) =>
    BLOCKED.has(route.request().resourceType()) ? route.abort() : route.continue(),
  );
  return ctx;
}

/** Decline non-essential cookies and remove any leftover overlay. */
async function dismissCookies(page: Page): Promise<void> {
  await page
    .locator('#onetrust-reject-all-handler')
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.evaluate(() => {
    document.getElementById('onetrust-consent-sdk')?.remove();
    document.querySelector('.onetrust-pc-dark-filter')?.remove();
  });
}

/**
 * Render a faction page with "Show Legends" toggled on, returning the page HTML.
 * Call only for factions whose markup ships the toggle (see `hasLegends`); base
 * data comes from plain HTTP and the caller diffs the two with `markLegends`.
 *
 * We only interact with the button and read the rendered DOM — no dependence on
 * the request/response shape. The Legends render in a single React commit, so the
 * unit count jumps straight to its full total; waiting for it to exceed the
 * current count is therefore exact (and deterministic under concurrency), not a
 * timed guess.
 */
export async function renderWithLegends(ctx: BrowserContext, url: string): Promise<string> {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await dismissCookies(page);
    const toggle = page.locator(LEGENDS_TOGGLE);
    await toggle.waitFor({ timeout: NAV_TIMEOUT }); // appears once React hydrates
    const before = await page.locator(UNIT_SELECTOR).count();
    await toggle.click({ timeout: ACTION_TIMEOUT }).catch(async () => {
      await dismissCookies(page); // a lingering overlay can intercept — clear + force.
      await toggle.click({ force: true, timeout: ACTION_TIMEOUT });
    });
    await page.waitForFunction(
      ([sel, n]) => document.querySelectorAll(sel as string).length > (n as number),
      [UNIT_SELECTOR, before] as const,
      { timeout: NAV_TIMEOUT },
    );
    return await page.content();
  } finally {
    await page.close();
  }
}

/** True if a faction page ships the "Show Legends" toggle (i.e. it has Legends). */
export const hasLegends = (html: string): boolean => html.includes('show-legends');

/**
 * Render a faction page with its rules panels (`RULES_PANELS`: the "Welcome…" notes
 * and "Muster Armies") open, returning the page HTML for the pure
 * `extractNotesMarkdown` / `extractMusterMarkdown` (identical across faction pages).
 * We only drive the page: click each panel's button, then wait for the panel it
 * controls (`aria-controls`) to have content — a deterministic signal, not a timeout.
 */
export async function renderRulesPanels(ctx: BrowserContext, url: string): Promise<string> {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    await dismissCookies(page);
    for (const label of Object.values(RULES_PANELS)) {
      await page.getByRole('button', { name: label }).click({ timeout: ACTION_TIMEOUT });
      await page.waitForFunction(
        (l) => {
          const button = [...document.querySelectorAll('button')].find((b) =>
            b.textContent?.trim().startsWith(l),
          );
          const id = button?.getAttribute('aria-controls');
          return !!id && !!document.getElementById(id)?.textContent?.trim();
        },
        label,
        { timeout: ACTION_TIMEOUT },
      );
    }
    return await page.content();
  } finally {
    await page.close();
  }
}
