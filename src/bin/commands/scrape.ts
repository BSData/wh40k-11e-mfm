import { type ScrapeOptions, scrape } from '../../scrape.js';
import { type Command, flag, list, text, UsageError } from '../command.js';

export const command: Command = {
  help: `usage: mfm scrape [options]

Scrapes the Munitorum Field Manual into --out over plain HTTP, one request per page:
each faction's YAML, Legends included, validated, and on a full run meta.yaml with the
rules panels. A faction that fails doesn't stop the others, but the run exits 1 at the
end. \`pnpm scrape\` runs this.

  --faction <slug>     one faction only; meta.yaml is left as it is
  --out <dir>          where the YAML goes (default: data)
  --concurrency <n>    faction pages in flight at once (default: 4)
  --browser            also cross-check every page against Google Chrome's render
                       (the installed Chrome; nothing downloads one), failing the
                       faction or the rules panels that differ
  --order <name|page>  entity order: name (default, alphabetical) or page
  --report <file>      write the per-faction failure report there, for
                       \`mfm report-failure\`
  --dates-from <dir>   another snapshot to match firstSeen against (repeatable)
  --ignore-name-case   match firstSeen ignoring how names are cased, to regenerate
                       data/ after a change to the Names rule (specs/data-model.md)
`,
  options: {
    faction: { type: 'string' },
    out: { type: 'string' },
    concurrency: { type: 'string' },
    browser: { type: 'boolean' },
    order: { type: 'string' },
    report: { type: 'string' },
    'dates-from': { type: 'string', multiple: true },
    'ignore-name-case': { type: 'boolean' },
  },
  positionals: 0,
  async run(values) {
    const order = text(values, 'order') ?? 'name';
    if (order !== 'name' && order !== 'page') {
      throw new UsageError(`--order must be "name" or "page", got: ${order}`);
    }
    const concurrency = text(values, 'concurrency') ?? '4';
    if (!/^[1-9][0-9]*$/.test(concurrency)) {
      throw new UsageError(`--concurrency must be a whole number above 0, got: ${concurrency}`);
    }
    const opts: ScrapeOptions = {
      out: text(values, 'out') ?? 'data',
      concurrency: Number(concurrency),
      browser: flag(values, 'browser'),
      order,
      datesFrom: list(values, 'dates-from'),
      ignoreNameCase: flag(values, 'ignore-name-case'),
    };
    const faction = text(values, 'faction');
    if (faction) opts.faction = faction;
    const report = text(values, 'report');
    if (report) opts.report = report;
    return scrape(opts);
  },
};
