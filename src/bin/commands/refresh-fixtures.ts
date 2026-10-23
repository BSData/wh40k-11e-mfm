import { existsSync, readFileSync } from 'node:fs';
import {
  downloadFixtures,
  FIXTURES_DIR,
  fixturesForFailures,
  refreshFixtures,
} from '../../fixtures.js';
import { type Command, list, text, UsageError } from '../command.js';

export const command: Command = {
  help: `usage: mfm refresh-fixtures [--only <name>]... [--failed <report>] [--out <dir>]

Re-downloads the HTML fixtures the parser tests run against into test/fixtures/
(\`pnpm refresh-fixtures\` runs this); then review the diff and update the snapshots
with \`pnpm test -u\`. Needs the network, and the installed Google Chrome for the two
browser renders (necrons-legends.html, necrons-panels.html); nothing downloads one.

  --only <name>      just this fixture (repeatable), leaving the rest as they are. An
                     unknown name stops the run before anything is downloaded.
  --failed <report>  instead, the pages a failed scrape's report (\`pnpm scrape --report\`)
                     names, for the drift fixer: each failed faction's fixtures, or its
                     page as the scrape fetches it (<slug>-legends-cookie.html) when no
                     fixture covers it, and necrons-panels-rsc.html for the rules panels.
                     Over HTTP only. A failed fetch is an outage, not drift, so it gets
                     nothing, and neither does a missing report; nothing is saved unless
                     every page downloads.
  --out <dir>        where to save them (default: test/fixtures/)
`,
  options: {
    only: { type: 'string', multiple: true },
    failed: { type: 'string' },
    out: { type: 'string' },
  },
  positionals: 0,
  async run(values, _, io) {
    const only = list(values, 'only');
    const report = text(values, 'failed');
    const out = text(values, 'out') ?? FIXTURES_DIR;
    if (report === undefined) {
      await refreshFixtures(only, out);
      return 0;
    }
    if (only.length > 0) throw new UsageError('--only and --failed pick fixtures differently');
    const fixtures = existsSync(report) ? fixturesForFailures(readFileSync(report, 'utf8')) : [];
    if (fixtures.length === 0) {
      io.err('Nothing to refresh: no failure the parser could have caused.\n');
      return 0;
    }
    await downloadFixtures(fixtures, out);
    return 0;
  },
};
