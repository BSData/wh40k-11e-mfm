import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/bin/mfm.js';
import { openCrossCheck } from '../src/cross-check.js';
import { factionFromYaml, factionToYaml, mapNames } from '../src/emit.js';
import { BASE_URL, factionUrl, fetchText, LEGENDS_COOKIE } from '../src/fetch.js';

// The pipeline end to end, offline, as `mfm scrape` runs it: the network is stubbed with
// saved fixtures, so what runs is the real parse → validate → write path. The browser
// cross-check is stubbed too; test/cross-check.test.ts runs it on fixtures.
vi.mock('../src/fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/fetch.js')>()),
  fetchText: vi.fn(),
}));
vi.mock('../src/cross-check.js', () => ({ openCrossCheck: vi.fn() }));

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

/** A one-faction index, so a full run (no `--faction`) scrapes just Necrons. */
const INDEX = '<html><body><p>v1.6</p><a href="/en/necrons">Necrons</a></body></html>';
const OLD_META = 'version: "1.0"\nlastUpdated: 2026-01-01\nnotes: kept\nfactions:\n  - necrons\n';

/** The Legends-cookie page with its "Muster Armies" collapsible relabelled in the payload. */
const withoutMuster = () => {
  const label = (text: string) => `\\"children\\":\\"${text}\\"`;
  return fixture('necrons-legends-cookie.html').replaceAll(
    label('Muster Armies'),
    label('Army Rules'),
  );
};

let out: string;
const meta = () => readFileSync(join(out, 'meta.yaml'), 'utf8');
const report = () => readFileSync(join(out, 'failures.md'), 'utf8');
const scrape = (...args: string[]) =>
  main(['scrape', '--out', out, '--report', join(out, 'failures.md'), ...args]);

/** Serve the index, and `page` for every faction page. */
const serve = (page: () => string | Promise<string>) =>
  vi.mocked(fetchText).mockImplementation(async (url) => (url === BASE_URL ? INDEX : page()));

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'mfm-cli-'));
  writeFileSync(join(out, 'meta.yaml'), OLD_META);
  vi.mocked(fetchText).mockReset();
  vi.mocked(openCrossCheck).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('mfm scrape — HTTP only', () => {
  it('fetches each faction page once, with the Legends cookie', async () => {
    serve(() => fixture('necrons-legends-cookie.html'));
    expect(await scrape()).toBe(0);
    expect(vi.mocked(fetchText).mock.calls).toEqual([
      [BASE_URL],
      [factionUrl('necrons'), { cookie: LEGENDS_COOKIE }],
    ]);
    expect(openCrossCheck).not.toHaveBeenCalled();
  });

  it('writes the Legends, marked, and the rules panels from the same page', async () => {
    serve(() => fixture('necrons-legends-cookie.html'));
    expect(await scrape()).toBe(0);
    const necrons = readFileSync(join(out, 'necrons.yaml'), 'utf8');
    expect(necrons.match(/legends: true/g)).toHaveLength(12);
    expect(meta()).toContain('## SELECT BATTLE SIZE');
    expect(meta()).toContain('## UNITS');
  });

  it('fails a faction whose page comes back without its Legends', async () => {
    serve(() => fixture('necrons-panels-rsc.html')); // the plain page: the cookie ignored
    expect(await scrape()).toBe(1);
    expect(report()).toMatch(
      /necrons[\s\S]*the page has the Legends toggle but no LEGENDS section/,
    );
    expect(existsSync(join(out, 'necrons.yaml'))).toBe(false);
  });
});

describe('mfm scrape — the rules panels on a full run', () => {
  it('fails the run and leaves meta.yaml untouched when a panel is not in the payload', async () => {
    serve(withoutMuster);
    expect(await scrape()).toBe(1);
    expect(meta()).toBe(OLD_META);
    expect(report()).toMatch(/rules panels[\s\S]*rules panel "Muster Armies": no collapsible/);
    // The factions themselves still parse and are written.
    expect(existsSync(join(out, 'necrons.yaml'))).toBe(true);
  });

  it('fails the panels too when the page they are read from does not load', async () => {
    serve(() => Promise.reject(new Error('HTTP 503 for necrons')));
    expect(await scrape()).toBe(1);
    expect(meta()).toBe(OLD_META);
    expect(report()).toMatch(/rules panels[\s\S]*the page they are read from \("necrons"\)/);
  });

  it('reads no panels and writes no meta.yaml on a --faction run', async () => {
    serve(withoutMuster);
    expect(await scrape('--faction', 'necrons')).toBe(0);
    expect(meta()).toBe(OLD_META);
  });
});

describe('mfm scrape --browser — the cross-check', () => {
  const stub = () => {
    const check = {
      faction: vi.fn(async () => {}),
      panels: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    vi.mocked(openCrossCheck).mockResolvedValue(check);
    return check;
  };

  it('checks every faction and the panels against the browser, then closes it', async () => {
    const check = stub();
    serve(() => fixture('necrons-legends-cookie.html'));
    expect(await scrape('--browser')).toBe(0);
    expect(check.faction).toHaveBeenCalledWith(
      factionUrl('necrons'),
      expect.objectContaining({ slug: 'necrons' }),
      new Set(['necrons']),
    );
    expect(check.panels).toHaveBeenCalledWith(
      factionUrl('necrons'),
      expect.objectContaining({ muster: expect.stringContaining('## SELECT BATTLE SIZE') }),
    );
    expect(check.close).toHaveBeenCalledOnce();
  });

  it('fails, and writes nothing for, what the browser shows differently', async () => {
    const check = stub();
    check.faction.mockRejectedValue(new Error('"necrons": the browser render differs'));
    check.panels.mockRejectedValue(new Error('rules panel "Muster Armies" in the browser differs'));
    serve(() => fixture('necrons-legends-cookie.html'));
    expect(await scrape('--browser')).toBe(1);
    expect(existsSync(join(out, 'necrons.yaml'))).toBe(false);
    expect(meta()).toBe(OLD_META);
    expect(report()).toMatch(/the browser render differs/);
    expect(report()).toMatch(/rules panels[\s\S]*in the browser differs/);
    expect(check.close).toHaveBeenCalledOnce();
  });

  it('stops before any faction page when Chrome does not start', async () => {
    vi.mocked(openCrossCheck).mockRejectedValue(new Error('Google Chrome did not start.'));
    serve(() => fixture('necrons-legends-cookie.html'));
    await expect(scrape('--browser')).rejects.toThrow('Google Chrome did not start.');
    expect(vi.mocked(fetchText).mock.calls).toEqual([[BASE_URL]]);
    expect(existsSync(join(out, 'necrons.yaml'))).toBe(false);
    expect(meta()).toBe(OLD_META);
  });
});

describe('mfm scrape — its options', () => {
  it.each([
    [['--order', 'alphabetical'], /--order must be "name" or "page", got: alphabetical/],
    [['--concurrency', '0'], /--concurrency must be a whole number above 0, got: 0/],
    [['--concurrency', 'four'], /--concurrency must be a whole number above 0, got: four/],
    [['--faction'], /--faction/],
    [['--legends'], /Unknown option '--legends'/],
    [['--no-legends'], /Unknown option '--no-legends'/],
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

describe('mfm scrape --ignore-name-case, for a regeneration after a change to the Names rule', () => {
  const OLD_DATE = '2026-01-01';
  const necrons = () => readFileSync(join(out, 'necrons.yaml'), 'utf8');

  beforeEach(() => {
    serve(() => fixture('necrons-legends-cookie.html'));
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
