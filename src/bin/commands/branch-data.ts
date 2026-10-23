import { exportBranchData } from '../../ops/open-prs.js';
import type { Command } from '../command.js';

export const command: Command = {
  help: `usage: mfm branch-data <branch> <dir>

Fetches <branch> from origin (one commit deep in a shallow checkout; a full clone
stays full) and copies the files under its data/ into <dir>. The checkout itself is
left as it is.
`,
  options: {},
  positionals: 2,
  async run(_, [branch = '', dir = ''], io) {
    await exportBranchData(branch, dir);
    io.err(`Copied ${branch}'s data/ into ${dir}.\n`);
    return 0;
  },
};
