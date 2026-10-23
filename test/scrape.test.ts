import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/bin/mfm.js';
import {
  createScrapeContext,
  launchBrowser,
  renderRulesPanels,
  renderWithLegends,
} from '../src/browser.js';
import { factionFromYaml, factionToYaml, mapNames } from '../src/emit.js';
import { BASE_URL, fetchText } from '../src/fetch.js';

// The pipeline end to end, offline, as `mfm scrape` runs it: the network and the browser
// are stubbed with saved fixtures, so what runs is the real parse → validate → write path.
vi.mock('../src/fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/fetch.js')>()),
  fetchText: vi.fn(),
}));
vi.mock('../src/browser.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser.js')>()),
  launchBrowser: vi.fn(async () => ({ close: async () => {} })),
  createScrapeContext: vi.fn(async () => ({ close: async () => {} })),
  renderWithLegends: vi.fn(),
  renderRulesPanels: vi.fn(),
}));

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

/** A one-faction index, so a full run (no `--faction`) scrapes just Necrons. */
const INDEX = '<html><body><p>v1.1</p><a href="/en/necrons">Necrons</a></body></html>';
const OLD_META = 'version: "1.0"\nlastUpdated: 2026-01-01\nnotes: kept\nfactions:\n  - necrons\n';

describe('mfm scrape — the rules panels on a full run', () => {
  let out: string;
  const meta = () => readFileSync(join(out, 'meta.yaml'), 'utf8');

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'mfm-cli-'));
    writeFileSync(join(out, 'meta.yaml'), OLD_META);
    vi.mocked(fetchText).mockImplementation(async (url) =>
      url === BASE_URL ? INDEX : fixture('necrons.html'),
    );
    vi.mocked(renderWithLegends).mockResolvedValue(fixture('necrons-legends.html'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes notes and muster to meta.yaml when the panels render', async () => {
    vi.mocked(renderRulesPanels).mockResolvedValue(fixture('necrons-panels.html'));
    expect(await main(['scrape', '--out', out])).toBe(0);
    expect(meta()).toContain('## SELECT BATTLE SIZE');
    expect(meta()).toContain('## UNITS');
  });

  it('fails the run and leaves meta.yaml untouched when the panels fail to render', async () => {
    vi.mocked(renderRulesPanels).mockRejectedValue(new Error('Timeout 15000ms exceeded'));
    const report = join(out, 'failures.md');
    expect(await main(['scrape', '--out', out, '--report', report])).toBe(1);
    expect(meta()).toBe(OLD_META);
    expect(readFileSync(report, 'utf8')).toMatch(/rules panels[\s\S]*Timeout 15000ms exceeded/);
    // The factions themselves still parse and are written.
    expect(existsSync(join(out, 'necrons.yaml'))).toBe(true);
  });

  it('fails the run and leaves meta.yaml untouched when a panel renders empty', async () => {
    // The HTTP page has both panels closed, so neither panel's text can be extracted.
    vi.mocked(renderRulesPanels).mockResolvedValue(fixture('necrons.html'));
    const report = join(out, 'failures.md');
    expect(await main(['scrape', '--out', out, '--report', report])).toBe(1);
    expect(meta()).toBe(OLD_META);
    expect(readFileSync(report, 'utf8')).toMatch(/rules panels[\s\S]*Welcome to the Munitorum/);
  });
});

describe('mfm scrape — its options', () => {
  beforeEach(() => {
    vi.mocked(fetchText).mockClear();
  });

  it.each([
    [['--order', 'alphabetical'], /--order must be "name" or "page", got: alphabetical/],
    [['--concurrency', '0'], /--concurrency must be a whole number above 0, got: 0/],
    [['--concurrency', 'four'], /--concurrency must be a whole number above 0, got: four/],
    [['--faction'], /--faction/],
    [['--legends'], /Unknown option '--legends'/],
    [['--ignore-names-case'], /Unknown option '--ignore-names-case'/],
  ])('refuses %j before fetching anything', async (args, message) => {
    let stderr = '';
    const io = {
      out: () => {},
      err: (text: string) => {
        stderr += text;
      },
    };
    expect(await main(['scrape', ...args], io)).toBe(2);
    expect(stderr).toMatch(message);
    expect(fetchText).not.toHaveBeenCalled();
  });
});

describe('mfm scrape — a browser that fails to open a page context', () => {
  it('is closed, so the run ends instead of hanging on it', async () => {
    const close = vi.fn(async () => {});
    vi.mocked(launchBrowser).mockResolvedValueOnce({ close } as never);
    vi.mocked(createScrapeContext).mockRejectedValueOnce(new Error('context failed'));
    vi.mocked(fetchText).mockImplementation(async (url) =>
      url === BASE_URL ? INDEX : fixture('necrons.html'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = mkdtempSync(join(tmpdir(), 'mfm-cli-'));
    try {
      await expect(main(['scrape', '--out', out])).rejects.toThrow('context failed');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(out, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});

describe('mfm scrape --ignore-name-case, for a regeneration after a change to the Names rule', () => {
  const OLD_DATE = '2026-01-01';
  let out: string;
  const meta = () => readFileSync(join(out, 'meta.yaml'), 'utf8');
  const necrons = () => readFileSync(join(out, 'necrons.yaml'), 'utf8');

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'mfm-cli-'));
    vi.mocked(fetchText).mockImplementation(async (url) =>
      url === BASE_URL ? INDEX : fixture('necrons.html'),
    );
    vi.mocked(renderWithLegends).mockResolvedValue(fixture('necrons-legends.html'));
    vi.mocked(renderRulesPanels).mockResolvedValue(fixture('necrons-panels.html'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Leave necrons.yaml as an older scrape wrote it: dated OLD_DATE, then `edit`ed. */
  async function scrapedEarlier(edit: (yaml: string) => string) {
    expect(await main(['scrape', '--out', out])).toBe(0);
    const yaml = necrons().replace(/^firstSeen: .*$/m, `firstSeen: ${OLD_DATE}`);
    writeFileSync(join(out, 'necrons.yaml'), edit(yaml));
  }
  /** The file as another casing rule wrote it: here, every name in capitals. */
  const oldCase = (yaml: string) =>
    factionToYaml(mapNames(factionFromYaml(yaml), (name) => name.toUpperCase()));

  it('keeps firstSeen and lastUpdated when only the case of names changed', async () => {
    await scrapedEarlier(oldCase);
    // Names of every kind necrons has were re-cased: units and detachments, `unique`, a
    // unit's attach list and an enhancement's.
    expect(necrons()).toContain('  - name: IMOTEKH THE STORMLORD');
    expect(necrons()).toContain('    unique: DYNASTY');
    expect(necrons()).toMatch(/^ {6}- IMMORTALS$/m);
    expect(necrons()).toMatch(/supportTo: \[ [^\]a-z]+ \]/);
    expect(await main(['scrape', '--out', out, '--ignore-name-case'])).toBe(0);
    expect(necrons()).not.toContain('  - name: IMOTEKH THE STORMLORD');
    expect(necrons()).toContain(`firstSeen: ${OLD_DATE}`);
    expect(meta()).toContain(`lastUpdated: ${OLD_DATE}`);
  });

  it('stamps the run date without the option', async () => {
    await scrapedEarlier(oldCase);
    expect(await main(['scrape', '--out', out])).toBe(0);
    expect(necrons()).not.toContain(`firstSeen: ${OLD_DATE}`);
  });

  it('stamps the run date when anything else changed too', async () => {
    await scrapedEarlier((yaml) =>
      oldCase(yaml).replace(/points: (\d+)/, (_, n) => `points: ${Number(n) + 5}`),
    );
    expect(await main(['scrape', '--out', out, '--ignore-name-case'])).toBe(0);
    expect(necrons()).not.toContain(`firstSeen: ${OLD_DATE}`);
  });

  it('compares enhancement names as they are, since they are not cased by the rule', async () => {
    await scrapedEarlier((yaml) => yaml.replace('Eldritch Nightmare', 'ELDRITCH NIGHTMARE'));
    expect(await main(['scrape', '--out', out, '--ignore-name-case'])).toBe(0);
    expect(necrons()).not.toContain(`firstSeen: ${OLD_DATE}`);
  });
});
