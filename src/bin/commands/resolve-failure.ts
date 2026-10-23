import { resolveFailure } from '../../ops/failure-issue.js';
import { githubFromEnv, runUrl } from '../../ops/github.js';
import type { Command } from '../command.js';

export const command: Command = {
  help: `usage: mfm resolve-failure

Comments on every open scrape-failure issue with a link to this successful run, and
closes it. Needs GITHUB_REPOSITORY, GITHUB_RUN_ID and GH_TOKEN.
`,
  options: {},
  positionals: 0,
  async run(_, __, io) {
    const gh = githubFromEnv();
    const closed = await resolveFailure(gh, runUrl(gh));
    if (closed.length > 0) io.err(`Closed ${closed.map((n) => `#${n}`).join(', ')}.\n`);
    return 0;
  },
};
