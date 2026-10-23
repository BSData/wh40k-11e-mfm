import { refreshFixtures } from '../../fixtures.js';
import { type Command, list } from '../command.js';

export const command: Command = {
  help: `usage: mfm refresh-fixtures [--only <name>]...

Re-downloads the HTML fixtures the parser tests run against into test/fixtures/
(\`pnpm refresh-fixtures\` runs this); then review the diff and update the snapshots
with \`pnpm test -u\`. Needs the network, and a browser for the two rendered fixtures.

  --only <name>  just this fixture (repeatable), leaving the rest as they are. An
                 unknown name stops the run before anything is downloaded.
`,
  options: { only: { type: 'string', multiple: true } },
  positionals: 0,
  async run(values) {
    await refreshFixtures(list(values, 'only'));
    return 0;
  },
};
