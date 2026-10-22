import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRulesPanels, renderWithLegends } from '../src/browser.js';
import { main } from '../src/cli.js';
import { BASE_URL, fetchText } from '../src/fetch.js';

// The pipeline end to end, offline: the network and the browser are stubbed with saved
// fixtures, so what runs is the real parse → validate → write path.
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

describe('scrape CLI — the rules panels on a full run', () => {
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
    expect(await main(['--out', out])).toBe(0);
    expect(meta()).toContain('## SELECT BATTLE SIZE');
    expect(meta()).toContain('## UNITS');
  });

  it('fails the run and leaves meta.yaml untouched when the panels fail to render', async () => {
    vi.mocked(renderRulesPanels).mockRejectedValue(new Error('Timeout 15000ms exceeded'));
    const report = join(out, 'failures.md');
    expect(await main(['--out', out, '--report', report])).toBe(1);
    expect(meta()).toBe(OLD_META);
    expect(readFileSync(report, 'utf8')).toMatch(/rules panels[\s\S]*Timeout 15000ms exceeded/);
    // The factions themselves still parse and are written.
    expect(existsSync(join(out, 'necrons.yaml'))).toBe(true);
  });

  it('fails the run and leaves meta.yaml untouched when a panel renders empty', async () => {
    // The HTTP page has both panels closed, so neither panel's text can be extracted.
    vi.mocked(renderRulesPanels).mockResolvedValue(fixture('necrons.html'));
    const report = join(out, 'failures.md');
    expect(await main(['--out', out, '--report', report])).toBe(1);
    expect(meta()).toBe(OLD_META);
    expect(readFileSync(report, 'utf8')).toMatch(/rules panels[\s\S]*Welcome to the Munitorum/);
  });
});
