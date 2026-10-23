import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launchBrowser, renderFaction, renderRulesPanels } from '../src/browser.js';
import { openCrossCheck } from '../src/cross-check.js';
import { factionUrl } from '../src/fetch.js';
import { CARD_SELECTOR, parseFaction, rulesPanels } from '../src/parse.js';

// The cross-check (`mfm scrape --browser`) on saved pages: Chrome is stubbed with the v1.6
// browser render (necrons-panels.html: the Legends shown, both panels open) and the plain
// v1.6 page as its default render (necrons-panels-rsc.html), against the HTTP side the
// scrape reads (necrons-legends-cookie.html).
vi.mock('../src/browser.js', () => ({
  launchBrowser: vi.fn(),
  renderFaction: vi.fn(),
  renderRulesPanels: vi.fn(),
}));

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const URL_ = factionUrl('necrons');
const http = () =>
  parseFaction(fixture('necrons-legends-cookie.html'), 'necrons', 'Necrons', new Set(), {
    legendsShown: true,
  });
const close = vi.fn(async () => {});

beforeEach(() => {
  vi.mocked(launchBrowser)
    .mockReset()
    .mockResolvedValue({ close } as never);
  vi.mocked(renderFaction)
    .mockReset()
    .mockResolvedValue({
      page: fixture('necrons-panels-rsc.html'),
      legends: fixture('necrons-panels.html'),
    });
  vi.mocked(renderRulesPanels).mockReset().mockResolvedValue(fixture('necrons-panels.html'));
});

describe('the browser cross-check', () => {
  it('passes when the browser shows what plain HTTP read', async () => {
    const check = await openCrossCheck();
    await expect(check.faction(URL_, http(), new Set())).resolves.toBeUndefined();
    await expect(
      check.panels(URL_, rulesPanels(fixture('necrons-panels-rsc.html'))),
    ).resolves.toBeUndefined();
    await check.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('names the first line that differs', async () => {
    const changed = http();
    const warriors = changed.units.find((u) => u.name === 'Necron Warriors');
    if (!warriors?.pricing[0]?.costs[0]) throw new Error('fixture changed');
    warriors.pricing[0].costs[0].points += 5;
    const check = await openCrossCheck();
    await expect(check.faction(URL_, changed, new Set())).rejects.toThrow(
      /^"necrons": the browser render differs from the HTTP page, from line \d+: HTTP ".*points: \d+.*", browser ".*"$/,
    );
  });

  it('finds the Legends by difference, so a Legends unit marked wrongly differs', async () => {
    const changed = http();
    const anrakyr = changed.units.find((u) => u.name === 'Anrakyr the Traveller');
    if (!anrakyr) throw new Error('fixture changed');
    delete anrakyr.legends;
    const check = await openCrossCheck();
    await expect(check.faction(URL_, changed, new Set())).rejects.toThrow(/legends: true/);
  });

  it('fails when a unit of the default render is missing once the Legends are shown', async () => {
    const $ = load(fixture('necrons-panels.html'));
    $(CARD_SELECTOR)
      .filter((_i, card) => $(card).children().first().text().trim() === 'NECRON WARRIORS')
      .remove();
    vi.mocked(renderFaction).mockResolvedValue({
      page: fixture('necrons-panels-rsc.html'),
      legends: $.html(),
    });
    const check = await openCrossCheck();
    await expect(check.faction(URL_, http(), new Set())).rejects.toThrow(
      '"necrons": base units missing from the Legends render: Necron Warriors (#1)',
    );
  });

  it('compares a faction without Legends with its default render', async () => {
    const titans = fixture('titan-legions.html');
    vi.mocked(renderFaction).mockResolvedValue({ page: titans });
    const content = parseFaction(titans, 'titan-legions', 'Titan Legions');
    const check = await openCrossCheck();
    await expect(
      check.faction(factionUrl('titan-legions'), content, new Set()),
    ).resolves.toBeUndefined();
  });

  it('fails a rules panel that differs, naming it', async () => {
    const panels = rulesPanels(fixture('necrons-panels-rsc.html'));
    const check = await openCrossCheck();
    await expect(
      check.panels(URL_, { ...panels, muster: `${panels.muster}\nmore` }),
    ).rejects.toThrow(
      /^rules panel "Muster Armies" in the browser differs from the HTTP page, from line \d+: HTTP "more", browser "\(end\)"$/,
    );
  });

  it('renders a page once more when the first render fails', async () => {
    vi.mocked(renderFaction).mockRejectedValueOnce(new Error('Timeout 45000ms exceeded'));
    vi.mocked(renderRulesPanels).mockRejectedValueOnce(new Error('Timeout 15000ms exceeded'));
    const check = await openCrossCheck();
    await expect(check.faction(URL_, http(), new Set())).resolves.toBeUndefined();
    await expect(
      check.panels(URL_, rulesPanels(fixture('necrons-panels-rsc.html'))),
    ).resolves.toBeUndefined();
    expect(renderFaction).toHaveBeenCalledTimes(2);
    expect(renderRulesPanels).toHaveBeenCalledTimes(2);
  });

  it('fails with the render error when the second render fails too', async () => {
    vi.mocked(renderFaction).mockRejectedValue(new Error('Timeout 45000ms exceeded'));
    const check = await openCrossCheck();
    await expect(check.faction(URL_, http(), new Set())).rejects.toThrow('Timeout 45000ms');
  });
});
