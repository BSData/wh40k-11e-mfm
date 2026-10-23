import { flagLine, loadSnapshots, needsAttention } from '../../diff.js';
import { githubFromEnv } from '../../ops/github.js';
import { ATTENTION_LABEL, setLabel } from '../../ops/labels.js';
import { type Command, flag, prNumber, text, UsageError } from '../command.js';

export const command: Command = {
  help: `usage: mfm attention <beforeDir> <afterDir> [--label --pr-number <n>]

Prints the changes between two snapshots that need attention, the ones more likely the
scraper misreading the site than GW changing it, one Markdown list item each. Prints
nothing when there are none.

  --label            put the needs-attention label on the update PR when there are any,
                     creating the label if the repository has none, and take it off
                     when there are none (needs --pr-number, GITHUB_REPOSITORY and
                     GH_TOKEN)
  --pr-number <n>    the open update PR
`,
  options: {
    label: { type: 'boolean' },
    'pr-number': { type: 'string' },
  },
  positionals: 2,
  async run(values, [beforeDir = '', afterDir = ''], io) {
    const pr = prNumber(text(values, 'pr-number'));
    const label = flag(values, 'label');
    if (label && pr === undefined) throw new UsageError('--label needs --pr-number');
    const { before, after, meta } = loadSnapshots(beforeDir, afterDir);
    const flags = needsAttention(before, after, { meta });
    for (const f of flags) io.out(`${flagLine(f)}\n`);
    if (label && pr !== undefined) {
      const done = await setLabel(githubFromEnv(), pr, ATTENTION_LABEL, flags.length > 0);
      io.err(`${ATTENTION_LABEL.name} on #${pr}: ${done}.\n`);
    }
    return 0;
  },
};
