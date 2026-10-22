import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { reportFailure, resolveFailure } from '../ops/failure-issue.js';
import { githubFromEnv, runUrl } from '../ops/github.js';
import { exportBranchData, exportOpenPrs } from '../ops/open-prs.js';
import { writeOutputs } from '../ops/outputs.js';
import { type Command, required, text } from './command.js';

/** The scrape workflow's GitHub chores: the open update PRs' data, and the failure issue. */

export const openPrs: Command = {
  summary: "list the open update PRs and copy each one's data/",
  help: `usage: mfm open-prs --out <dir> --json <file> [--output <file>]

Lists the open update PRs (label mfm-update, an mfm/ branch of this repository) into
<file>, for \`mfm plan\`, and copies each one's data/ into <dir>/<branch>. Prints a
step output, dates=…, with a --dates-from for each copy, for \`pnpm scrape\`. Needs
GITHUB_REPOSITORY and GH_TOKEN, and runs git in a checkout whose origin is GitHub.

  --out <dir>      where the copies go
  --json <file>    where the list goes
  --output <file>  append the step output to a step-output file, such as
                   $GITHUB_OUTPUT, instead
`,
  options: { out: { type: 'string' }, json: { type: 'string' }, output: { type: 'string' } },
  positionals: 0,
  async run(values, _, io) {
    const out = required(values, 'out');
    const json = required(values, 'json');
    const { prs, dirs } = await exportOpenPrs(githubFromEnv(), out);
    writeFileSync(json, `${JSON.stringify(prs)}\n`);
    for (const pr of prs) io.err(`Matching dates against the open ${pr.headRefName} PR.\n`);
    const dates = dirs.map((d) => `--dates-from ${d}`).join(' ');
    writeOutputs({ dates }, text(values, 'output'), io.out);
    return 0;
  },
};

export const branchData: Command = {
  summary: "copy a branch's data/ from origin",
  help: `usage: mfm branch-data <branch> <dir>

Fetches <branch> from origin, one commit deep, and copies the files under its data/
into <dir>. The checkout itself is left as it is.
`,
  options: {},
  positionals: 2,
  async run(_, [branch = '', dir = ''], io) {
    await exportBranchData(branch, dir);
    io.err(`Copied ${branch}'s data/ into ${dir}.\n`);
    return 0;
  },
};

export const reportFailureCommand: Command = {
  summary: 'open the scrape-failure issue, or comment on the open one',
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

export const resolveFailureCommand: Command = {
  summary: 'close the open scrape-failure issues after a successful run',
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
