import { describe, expect, it, vi } from 'vitest';
import { launchBrowser } from '../src/browser.js';

// Chrome itself isn't launched here (the tests run without one); this pins how the browser
// path asks for it, and what it says when there is none.
const launch = vi.hoisted(() => vi.fn());
vi.mock('playwright-core', () => ({ chromium: { launch } }));

describe('launchBrowser', () => {
  it('starts the installed Google Chrome, downloading nothing', async () => {
    launch.mockResolvedValueOnce({ close: async () => {} });
    await launchBrowser();
    expect(launch).toHaveBeenCalledWith({ channel: 'chrome' });
  });

  it('says so when there is no Chrome to start', async () => {
    launch.mockRejectedValueOnce(
      new Error(
        'browserType.launch: Chromium distribution \'chrome\' is not found at /opt/google/chrome/chrome\nRun "npx playwright install chrome"',
      ),
    );
    const error = await launchBrowser().catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/^Google Chrome did not start\. .*installs none/);
    // Only the first line of Playwright's message: the rest advises downloading a browser.
    expect(message).toContain("Chromium distribution 'chrome' is not found");
    expect(message).not.toContain('npx playwright install');
  });
});
