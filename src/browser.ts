import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { CARD_SELECTOR, RULES_PANELS, TIER_LABEL_RE, TIER_LABEL_SELECTOR } from './parse.js';

/**
 * Google Chrome, for tests and troubleshooting only: the cross-check (`mfm scrape
 * --browser`, src/cross-check.ts), `mfm render`, and the two browser-render fixtures. The
 * scrape itself is HTTP only and loads this module only for `--browser`.
 *
 * playwright-core downloads no browser: `channel: 'chrome'` launches the Google Chrome
 * installed on the machine, which GitHub's Ubuntu runner images ship. Nothing in the
 * project installs one.
 *
 * A render only drives the page's buttons and reads the rendered DOM, never the requests
 * or responses. Each page gets a fresh context, so no Legends cookie set by clicking the
 * toggle on one page carries over to the next, and image/font/media requests are blocked
 * so pages settle fast. See "The browser" in specs/scraping.md.
 */

const LEGENDS_TOGGLE = '#show-legends-label';
const NAV_TIMEOUT = 45_000;
const ACTION_TIMEOUT = 15_000;
const BLOCKED = new Set(['image', 'font', 'media']);

/** Start the installed Google Chrome, headless. */
export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch (err) {
    const reason = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
    throw new Error(
      'Google Chrome did not start. The browser path drives the Chrome installed on this ' +
        'machine (playwright-core, channel "chrome") and installs none: install Google ' +
        `Chrome, or leave the browser out. ${reason}`,
    );
  }
}

/** Run `fn` on a page of its own context, which blocks heavy assets; close both after. */
async function withPage<T>(browser: Browser, fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx: BrowserContext = await browser.newContext();
  try {
    await ctx.route('**/*', (route) =>
      BLOCKED.has(route.request().resourceType()) ? route.abort() : route.continue(),
    );
    return await fn(await ctx.newPage());
  } finally {
    await ctx.close();
  }
}

/** Load `url` until the network is quiet (React has hydrated), and decline cookies. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  await page
    .locator('#onetrust-reject-all-handler')
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.evaluate(() => {
    document.getElementById('onetrust-consent-sdk')?.remove();
    document.querySelector('.onetrust-pc-dark-filter')?.remove();
  });
}

/** A faction page as Chrome renders it: by default, and with "Show Legends" clicked. */
export interface FactionRender {
  page: string;
  /** Only for a page that ships the Legends toggle. */
  legends?: string;
}

/**
 * Render a faction page as a visitor sees it, and, if it ships the Legends toggle, again
 * after clicking it. The Legends render in a single React commit, so the unit-card count
 * jumps straight to its full total: waiting for it to exceed the default count is exact,
 * not a timed guess. Unit cards are counted the way the parser tells them apart
 * (`isUnitCard` in src/parse/page.ts): a card holding a pricing-tier label. Header styles
 * vary with the annotation layer, so they are no signal.
 */
export async function renderFaction(browser: Browser, url: string): Promise<FactionRender> {
  return withPage(browser, async (page) => {
    await open(page, url);
    const html = await page.content();
    const toggle = page.locator(LEGENDS_TOGGLE);
    if ((await toggle.count()) === 0) return { page: html };
    const unitCards = page
      .locator(CARD_SELECTOR)
      .filter({ has: page.locator(TIER_LABEL_SELECTOR, { hasText: TIER_LABEL_RE }) });
    const before = await unitCards.count();
    await toggle.click({ timeout: ACTION_TIMEOUT }).catch(async () => {
      // A lingering cookie overlay can intercept the click: force it.
      await toggle.click({ force: true, timeout: ACTION_TIMEOUT });
    });
    // The (before + 1)-th unit card exists once the count exceeds `before`.
    await unitCards.nth(before).waitFor({ state: 'attached', timeout: NAV_TIMEOUT });
    return { page: html, legends: await page.content() };
  });
}

/**
 * Render a faction page with its rules panels (`RULES_PANELS`: the "Welcome…" notes and
 * "Muster Armies") open, returning the page HTML for the pure `extractNotesMarkdown` /
 * `extractMusterMarkdown`. It clicks each panel's button, then waits for the panel it
 * controls (`aria-controls`) to have content: a deterministic signal, not a timeout.
 */
export async function renderRulesPanels(browser: Browser, url: string): Promise<string> {
  return withPage(browser, async (page) => {
    await open(page, url);
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
  });
}
