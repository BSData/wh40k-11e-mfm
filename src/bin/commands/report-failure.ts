import { existsSync, readFileSync } from 'node:fs';
import { reportFailure } from '../../ops/failure-issue.js';
import { githubFromEnv, runUrl } from '../../ops/github.js';
import { type Command, text } from '../command.js';

export const command: Command = {
  help: `usage: mfm report-failure [--details <file>]

Reports a failed scrape run: a comment on the open scrape-failure issue, or a new
issue when none is open. Links the run's log. Needs GITHUB_REPOSITORY, GITHUB_RUN_ID
and GH_TOKEN.

  --details <file>  the per-faction report (\`pnpm scrape --report\`); a missing file
                    means the run failed outside parsing
`,
  options: { details: { type: 'string' } },
  positionals: 0,
  async run(values, _, io) {
    const gh = githubFromEnv();
    const file = text(values, 'details');
    const details = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
    const issue = await reportFailure(gh, runUrl(gh), details);
    io.err(`${issue.created ? 'Opened' : 'Commented on'} issue #${issue.number}.\n`);
    return 0;
  },
};
