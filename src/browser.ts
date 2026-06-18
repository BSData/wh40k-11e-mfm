import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

/**
 * Headless-browser access for the bits that aren't in the server HTML:
 *  - Legends units (revealed by the client-only "Show Legends" toggle), and
 *  - the expandable "Welcome…" help text.
 *
 * Everything else is scraped over plain HTTP; this module is used only when
 * legends/notes are wanted. Pages are rendered, so the resulting HTML is already
 * hydrated — `parseFaction` runs on it unchanged (its template-hydration no-ops).
 *
 * Use one context (`createScrapeContext`) for the whole run: declining cookies
 * once persists, and image/font/media requests are blocked so pages settle fast.
 */

const NOTES_ANCHORS = ['To muster a Warhammer 40,000 army', 'Leader/Support'] as const;
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

/** Extract the expandable "Welcome…" help/notes text (identical across faction pages). */
export async function extractNotes(ctx: BrowserContext, url: string): Promise<string> {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    await dismissCookies(page);
    await page
      .getByText('Welcome to the Munitorum Field Manual', { exact: false })
      .click({ timeout: ACTION_TIMEOUT });
    // Wait for the expanded notes to actually be present (deterministic signal).
    await page.waitForFunction((a) => document.body.innerText.includes(a), NOTES_ANCHORS[1], {
      timeout: ACTION_TIMEOUT,
    });
    // NOTE: keep this callback free of named inner functions — the tsx/esbuild
    // transform wraps them with a `__name` helper that doesn't exist in-page.
    return await page.evaluate((anchors) => {
      // The tightest element containing both anchor phrases is the notes block.
      const candidates = Array.from(document.querySelectorAll('div,section')).filter((el) =>
        anchors.every((a) => (el.textContent ?? '').includes(a)),
      );
      candidates.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
      const el = candidates[0] as HTMLElement | undefined;
      return el ? el.innerText.replace(/\n{3,}/g, '\n\n').trim() : '';
    }, NOTES_ANCHORS);
  } finally {
    await page.close();
  }
}
