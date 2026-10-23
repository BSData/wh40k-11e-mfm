import { launchBrowser, renderFaction, renderRulesPanels } from '../../browser.js';
import { factionUrl } from '../../fetch.js';
import { type Command, flag, UsageError } from '../command.js';

export const command: Command = {
  help: `usage: mfm render <slug> [--legends | --panels]

Prints a faction page's HTML as Google Chrome renders it for a visitor, to troubleshoot
the page or compare it with what plain HTTP returns. Uses the Chrome installed on this
machine (playwright-core, channel "chrome"); nothing downloads a browser.

  --legends   after clicking "Show Legends" (the faction must have Legends)
  --panels    with both rules panels opened
`,
  options: { legends: { type: 'boolean' }, panels: { type: 'boolean' } },
  positionals: 1,
  async run(values, [slug = ''], io) {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new UsageError(`Not a faction slug: ${slug}`);
    const legends = flag(values, 'legends');
    const panels = flag(values, 'panels');
    if (legends && panels) throw new UsageError('--legends and --panels render different pages');
    const browser = await launchBrowser();
    try {
      const url = factionUrl(slug);
      if (panels) {
        io.out(await renderRulesPanels(browser, url));
        return 0;
      }
      const render = await renderFaction(browser, url);
      if (legends && render.legends === undefined) {
        io.err(`${url} has no Legends toggle.\n`);
        return 1;
      }
      io.out((legends ? render.legends : render.page) ?? '');
      return 0;
    } finally {
      await browser.close();
    }
  },
};
