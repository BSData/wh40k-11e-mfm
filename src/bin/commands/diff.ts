import { writeFileSync } from 'node:fs';
import { changelog, loadSnapshots, updateTitle } from '../../diff.js';
import { writeOutputs } from '../../ops/outputs.js';
import { type Command, text } from '../command.js';

export const command: Command = {
  help: `usage: mfm diff <beforeDir> <afterDir> [--body-file <path>] [--output <file>]

Prints the update's PR body: the changelog between two data/ snapshots, or
"No changes detected." when there are none.

  --body-file <path>  also write the body to <path>
  --output <file>     append the update's title (title=…) to a step-output file,
                      such as $GITHUB_OUTPUT
`,
  options: { 'body-file': { type: 'string' }, output: { type: 'string' } },
  positionals: 2,
  async run(values, [beforeDir = '', afterDir = ''], io) {
    const { before, after, meta } = loadSnapshots(beforeDir, afterDir);
    const body = changelog(before, after, { meta });
    const bodyFile = text(values, 'body-file');
    if (bodyFile) writeFileSync(bodyFile, body);
    // The workflow gives the title to the PR and to its commit.
    const output = text(values, 'output');
    if (output) writeOutputs({ title: updateTitle(before, after, { meta }) }, output, io.out);
    io.out(body);
    return 0;
  },
};
