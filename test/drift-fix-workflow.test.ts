import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * How `.github/workflows/drift-fix.yml` ends (docs/decisions/0031): the agent's step may
 * fail, so a run cut short at its limits still hands on its patch, and the job's last step
 * fails the run for any other end. That step's script runs here as it is, with bash and
 * jq, which GitHub's runners have; without them, it skips.
 */

const hasBash = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: { EXECUTION_FILE?: string; CLAUDE_CODE_SUBPROCESS_ENV_SCRUB?: string };
  with?: { path_to_claude_code_executable?: string };
  'continue-on-error'?: boolean;
}
interface Job {
  needs?: string[] | string;
  if?: string;
  steps: Step[];
}

const workflow = parse(
  readFileSync(
    fileURLToPath(new URL('../.github/workflows/drift-fix.yml', import.meta.url)),
    'utf8',
  ),
) as { jobs: { gate?: Job; agent?: Job; pr?: Job } };
const agent = workflow.jobs.agent?.steps ?? [];
const draft = agent.find((s) => s.id === 'agent');
const check = agent.at(-1);

describe('the drift fixer workflow', () => {
  it('has a gate, an agent and a PR job, and nothing else', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['gate', 'agent', 'pr']);
  });

  it("lets the agent's step fail, and ends the agent's job with the check", () => {
    expect(draft?.uses).toMatch(/^anthropics\/claude-code-action@[0-9a-f]{40}$/);
    expect(draft?.['continue-on-error']).toBe(true);
    expect(check?.name).toBe('Check the agent finished or stopped at a limit');
    expect(check?.env?.EXECUTION_FILE).toMatch(
      /^\$\{\{ steps\.agent\.outputs\.execution_file \}\}$/,
    );
    // Either would turn a failed agent green again.
    expect(check).not.toHaveProperty('continue-on-error');
    expect(check).not.toHaveProperty('if');
  });

  it("asks Claude Code for nothing it can't start with on a runner", () => {
    expect(draft?.env ?? {}).not.toHaveProperty('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
  });

  // docs/decisions/0032: a second pin drifts from the action's, and nothing bumps it.
  it('lets the action install the Claude Code its release pins', () => {
    expect(draft?.with ?? {}).not.toHaveProperty('path_to_claude_code_executable');
  });

  it('opens the PR only after the agent job succeeded', () => {
    expect(workflow.jobs.pr?.needs).toEqual(['gate', 'agent']);
    expect(workflow.jobs.pr?.if).toBe("needs.agent.result == 'success'");
  });
});

describe.skipIf(!hasBash)('the check at the end of the agent job', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'drift-fix-check-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /**
   * Runs the step, as Actions runs it, with a run record as Claude Code writes one: null
   * names a file that isn't there, and undefined names none, as when the action never set
   * its output (a failed start, or the timeout).
   */
  const run = (record: string | null | undefined) => {
    const file = join(scratch, `${Math.random().toString(36).slice(2)}.json`);
    if (typeof record === 'string') writeFileSync(file, record);
    return spawnSync('bash', ['-e', '-c', check?.run ?? 'exit 99'], {
      env: {
        ...process.env,
        EXECUTION_FILE: record === undefined ? '' : file.replaceAll('\\', '/'),
      },
      encoding: 'utf8',
    });
  };
  const result = (subtype: string, is_error: boolean) =>
    JSON.stringify([{ type: 'system' }, { type: 'result', subtype, is_error }]);

  it.each([
    ['finished', result('success', false)],
    ['stopped at its turn limit', result('error_max_turns', true)],
    ['stopped at its budget', result('error_max_budget_usd', true)],
  ])('lets a run through that %s', (_, record) => {
    expect(run(record).status).toBe(0);
  });

  it.each([
    ['ended in an API error', result('success', true)],
    ['failed while it ran', result('error_during_execution', true)],
    ['never started (no result)', JSON.stringify([{ type: 'system' }])],
    ['left an empty record', ''],
    ['left a record that is not JSON', 'error: bubblewrap is required'],
    ['left no record', null],
    ['never named a record', undefined],
  ])('fails a run that %s, and says why', (_, record) => {
    const { status, stdout } = run(record);
    expect(status).toBe(1);
    expect(stdout).toContain("::error title=The agent didn't finish::");
  });
});
