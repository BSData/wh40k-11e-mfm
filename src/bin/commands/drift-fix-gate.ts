import { driftFixGate } from '../../ops/drift-fix.js';
import { githubFromEnv, runUrl } from '../../ops/github.js';
import { writeOutputs } from '../../ops/outputs.js';
import { type Command, flag, required, text } from '../command.js';

export const command: Command = {
  help: `usage: mfm drift-fix-gate --run-id <id> [--manual] [--output <file>]

Decides whether drift-fix.yml's agent runs for a failed scrape run, and records a run
it lets through on the open scrape-failure issue (see "The drift fixer" in
specs/change-tracking.md). Prints step outputs: run=true or false, issue=<the open
failure issue>, artifact=<the drift artifact to hand the agent>. Needs
GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_RUN_ID and GH_TOKEN.

  --run-id <id>    the failed "Scrape MFM" run
  --manual         a maintainer's replay: also takes a dry run's artifact, and runs even
                   if this outage already had a drift-fix run
  --output <file>  append the step outputs to a step-output file, such as
                   $GITHUB_OUTPUT, instead
`,
  options: {
    'run-id': { type: 'string' },
    manual: { type: 'boolean' },
    output: { type: 'string' },
  },
  positionals: 0,
  async run(values, _, io) {
    const runId = required(values, 'run-id');
    const gh = githubFromEnv();
    // biome-ignore lint/complexity/useLiteralKeys: tsc's noPropertyAccessFromIndexSignature requires the bracket form on process.env, and the two rules disagree.
    const branch = process.env['GITHUB_REF_NAME'];
    if (!branch) throw new Error('GITHUB_REF_NAME is not set');
    const gate = await driftFixGate(gh, {
      runId,
      branch,
      manual: flag(values, 'manual'),
      thisRunUrl: runUrl(gh),
    });
    io.err(`${gate.run ? 'Running' : 'Skipping'}: ${gate.reason}\n`);
    writeOutputs(
      {
        run: String(gate.run),
        issue: gate.issue === undefined ? '' : String(gate.issue),
        artifact: gate.artifact ?? '',
      },
      text(values, 'output'),
      io.out,
    );
    return 0;
  },
};
