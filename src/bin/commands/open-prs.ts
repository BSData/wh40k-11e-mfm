import { writeFileSync } from 'node:fs';
import { githubFromEnv } from '../../ops/github.js';
import { exportOpenPrs } from '../../ops/open-prs.js';
import { writeOutputs } from '../../ops/outputs.js';
import { type Command, required, text } from '../command.js';

export const command: Command = {
  help: `usage: mfm open-prs --out <dir> --json <file> [--output <file>]

Lists the open update PRs (label mfm-update, an mfm/ branch of this repository) into
<file>, for \`mfm plan\`, and copies each one's data/ into <dir>/<branch>, and its body
into <dir>/<branch>.body.md, for the brief (src/ops/brief.ts). Prints a step output,
dates=…, with a --dates-from for each copy, for \`pnpm scrape\`. Needs GITHUB_REPOSITORY
and GH_TOKEN, and runs git in a checkout whose origin is GitHub.

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
