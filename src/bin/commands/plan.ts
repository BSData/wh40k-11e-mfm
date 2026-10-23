import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadVersion } from '../../diff.js';
import { writeOutputs } from '../../ops/outputs.js';
import { planUpdate, UpdatePr } from '../../stack.js';
import { type Command, text } from '../command.js';

export const command: Command = {
  help: `usage: mfm plan <openPrs.json> <scrapedDataDir> [--output <file>]

Plans the update PR for the scraped site version (from <scrapedDataDir>/meta.yaml),
given the open PRs (\`mfm open-prs --json\`), and prints it as step outputs: branch=…,
base=… and below=… (the PRs below it, bottom first, space-separated).

  --output <file>  append them to a step-output file, such as $GITHUB_OUTPUT, instead
`,
  options: { output: { type: 'string' } },
  positionals: 2,
  async run(values, [prsFile = '', dataDir = ''], io) {
    const version = loadVersion(dataDir);
    if (!version) {
      throw new Error(`No site version in ${dataDir}/meta.yaml, so no update branch to name.`);
    }
    const prs = z.array(UpdatePr).parse(JSON.parse(readFileSync(prsFile, 'utf8')));
    const p = planUpdate(prs, version);
    const outputs = { branch: p.branch, base: p.base, below: p.below.join(' ') };
    writeOutputs(outputs, text(values, 'output'), io.out);
    return 0;
  },
};
