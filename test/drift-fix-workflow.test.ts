import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * How `.github/workflows/drift-fix.yml` ends (docs/decisions/0031): the agent's step may
 * fail, so a run cut short at its limits still hands on its patch, and the job's last step
 * fails the run for any other end. That step's script runs here as it is, with bash and
 * jq, which GitHub's runners have; without them, it skips. And what the job installs
 * through its egress block: Claude Code, by the action (0032), and Node, by pnpm.
 */

const hasBash = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: { EXECUTION_FILE?: string; CLAUDE_CODE_SUBPROCESS_ENV_SCRUB?: string; GH_TOKEN?: string };
  with?: {
    path_to_claude_code_executable?: string;
    'allowed-endpoints'?: string;
    name?: string;
    prompt?: string;
    draft?: string;
    'sign-commits'?: boolean;
    [permission: `permission-${string}`]: string;
  };
  'continue-on-error'?: boolean;
}
interface Job {
  needs?: string[] | string;
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}

const workflow = parse(
  readFileSync(
    fileURLToPath(new URL('../.github/workflows/drift-fix.yml', import.meta.url)),
    'utf8',
  ),
) as { jobs: { gate?: Job; agent?: Job; pr?: Job; merge?: Job } };
const agent = workflow.jobs.agent?.steps ?? [];
const draft = agent.find((s) => s.id === 'agent');
const check = agent.at(-1);
/** The hosts the agent job's egress block lets through. */
const allowed = (
  agent.find((s) => s.uses?.startsWith('step-security/harden-runner@'))?.with?.[
    'allowed-endpoints'
  ] ?? ''
).split(/\s+/);

describe('the drift fixer workflow', () => {
  it('has a gate, an agent, a PR and a merge job, and nothing else', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['gate', 'agent', 'pr', 'merge']);
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

  // Nothing in the repository uses these hosts, so nothing else would notice them gone
  // before an outage's run failed at the install.
  it("lets the agent's job reach Claude Code's installer", () => {
    expect(allowed).toEqual(expect.arrayContaining(['claude.ai:443', 'downloads.claude.ai:443']));
  });

  // Refused the mirror, pnpm 11.20 retries for over a minute before going on without it,
  // and later releases fail the install (pnpm/pnpm#14854).
  it("lets pnpm's install of Node read its checksums", () => {
    expect(allowed).toEqual(
      expect.arrayContaining(['nodejs.org:443', 'unofficial-builds.nodejs.org:443']),
    );
  });

  it('opens the PR only after the agent job succeeded', () => {
    expect(workflow.jobs.pr?.needs).toEqual(['gate', 'agent']);
    expect(workflow.jobs.pr?.if).toBe("needs.agent.result == 'success'");
  });
});

/** Where `name` (a step name, or a step id) is in `steps`. */
const at = (steps: Step[], name: string) =>
  steps.findIndex((s) => s.name === name || s.id === name);

// docs/decisions/0040: the page goes in from the scrape's artifact, never from the model.
describe("the scrape's page, in the agent's job and the PR job", () => {
  const pr = workflow.jobs.pr;
  const prSteps = pr?.steps ?? [];

  it('puts the new pages where the agent’s tests read them, before the agent starts', () => {
    const copy = at(agent, 'Put the new pages where the tests read them');
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(at(agent, 'agent'));
  });

  it('leaves the copied pages out of the patch', () => {
    expect(agent.find((s) => s.name === 'Make the patch')?.run).toContain(
      "':(exclude)test/fixtures'",
    );
  });

  it('tells the agent about the pages, the smoke test and how to ask for review', () => {
    const prompt = draft?.with?.prompt ?? '';
    expect(prompt).toContain('test/fixtures/');
    expect(prompt).toContain('smoke test');
    expect(prompt).toContain('Needs review:');
  });

  it('downloads the same drift artifact in the PR job, and hands its pages to the check', () => {
    expect(pr?.permissions).toMatchObject({ actions: 'read' });
    const download = prSteps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(
      prSteps.filter((s) =>
        /^\$\{\{ needs\.gate\.outputs\.artifact \}\}$/.test(s.with?.name ?? ''),
      ),
    ).toHaveLength(1);
    expect(download).toBeDefined();
    expect(prSteps.find((s) => s.id === 'patch')?.run).toContain(
      '--drift "$RUNNER_TEMP/drift/fixtures"',
    );
  });

  it('opens a draft for high risk, a signed commit either way, and hands the merge on', () => {
    const open = prSteps.find((s) => s.uses?.startsWith('peter-evans/create-pull-request@'));
    expect(open?.with?.draft).toMatch(/^\$\{\{ steps\.patch\.outputs\.risk != 'low' \}\}$/);
    expect(open?.with?.['sign-commits']).toBe(true);
    expect(Object.keys(pr?.outputs ?? {}).sort()).toEqual(
      ['head', 'number', 'owners', 'reasons', 'risk'].sort(),
    );
  });
});

// docs/decisions/0040: the merge runs no repository code, and holds the App's key only to
// start the scrape.
describe('the merge job', () => {
  const merge = workflow.jobs.merge;
  const steps = merge?.steps ?? [];
  const mint = steps.find((s) => s.uses?.startsWith('actions/create-github-app-token@'));
  const scrape = steps.find((s) => s.name === 'Start the scrape');

  it('runs only for a low-risk fix, on main, after the PR job', () => {
    expect(merge?.needs).toEqual(['gate', 'pr']);
    expect(merge?.if).toBe("needs.pr.outputs.risk == 'low' && github.ref_name == 'main'");
  });

  it('checks out nothing and runs no repository code', () => {
    expect(steps.some((s) => s.uses?.startsWith('actions/checkout@'))).toBe(false);
    expect(steps.some((s) => s.uses?.startsWith('pnpm/setup@'))).toBe(false);
    for (const s of steps) expect(s.run ?? '').not.toMatch(/\b(?:node|tsx|pnpm|npx|npm)\b/);
  });

  // GitHub starts no workflow_run for a run the workflow's own token started, so a scrape
  // started with it would never hand its failure to the drift fixer (0040, After it
  // shipped). The token is minted after the wait, which can outlast its hour.
  it('starts the scrape with an App token that can do nothing else, minted after the wait', () => {
    const at = (s: Step | undefined) => (s ? steps.indexOf(s) : -1);
    const waits = steps.find((s) => s.id === 'merge');
    expect(waits?.name).toBe('Merge once the checks pass');
    expect(at(mint)).toBeGreaterThan(at(waits));
    expect(at(scrape)).toBeGreaterThan(at(mint));
    const permissions = Object.entries(mint?.with ?? {}).filter(([k]) =>
      k.startsWith('permission-'),
    );
    expect(permissions).toEqual([['permission-actions', 'write']]);
    expect(scrape?.env?.GH_TOKEN).toBe(`\${{ steps.${mint?.id}.outputs.token }}`);
    expect(scrape?.run?.trim()).toBe('gh workflow run scrape.yml --ref main');
    for (const s of [mint, scrape]) {
      expect(s?.if).toBe(`\${{ !cancelled() && steps.merge.outputs.scrape == 'true' }}`);
    }
  });

  it('holds the App key only where it mints that token, and uses the token only there', () => {
    for (const s of steps.filter((s) => s !== mint)) {
      expect(JSON.stringify(s)).not.toContain('secrets.');
    }
    for (const s of steps.filter((s) => s !== scrape)) {
      expect(JSON.stringify(s)).not.toContain('outputs.token');
    }
  });

  it('holds what the merge, the checks and the comment need, and no more', () => {
    expect(merge?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
      issues: 'write',
      checks: 'read', // gh pr checks
      statuses: 'read',
    });
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

/**
 * The merge job's step, run as Actions runs it, with bash and jq, against a `gh` that only
 * logs what it is asked and answers `pr checks` with what each test hands it.
 */
describe.skipIf(!hasBash)('the merge step', () => {
  const step = workflow.jobs.merge?.steps.find((s) => s.name === 'Merge once the checks pass');
  const scratch = mkdtempSync(join(tmpdir(), 'drift-fix-merge-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const posix = (path: string) => path.replaceAll('\\', '/');
  const { PATH = '' } = process.env;
  let runs = 0;

  /** The checks `gh pr checks` reports, one answer per call, the last one repeating. */
  type Checks = { name: string; bucket: string; workflow?: string }[];
  const run = (answers: Checks[], env: Record<string, string> = {}) => {
    const dir = join(scratch, `run-${runs++}`);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    for (const [i, checks] of answers.entries()) {
      writeFileSync(join(dir, `checks-${i + 1}.json`), JSON.stringify(checks));
    }
    writeFileSync(
      join(dir, 'bin', 'gh'),
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$STUB/log"',
        'case "$1 $2" in',
        '  "pr checks")',
        '    n=$(( $(cat "$STUB/calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB/calls"',
        `    f="$STUB/checks-$n.json"; [ -f "$f" ] || f="$STUB/checks-${answers.length}.json"`,
        '    cat "$f" ;;',
        '  "pr merge") exit "$MERGE_EXIT" ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const result = spawnSync('bash', ['-e', '-c', step?.run ?? 'exit 99'], {
      env: {
        ...process.env,
        PATH: `${posix(join(dir, 'bin'))}:${PATH}`,
        STUB: posix(dir),
        GITHUB_OUTPUT: posix(join(dir, 'output')),
        PR: '7',
        SHA: 'abc123',
        ISSUE: '113',
        OWNERS: '@amis92',
        GH_REPO: 'o/r',
        MERGE_EXIT: '0',
        WAIT_SECONDS: '2',
        POLL_SECONDS: '0',
        ...env,
      },
      encoding: 'utf8',
    });
    const read = (name: string) => {
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch {
        return '';
      }
    };
    /** What gh was asked, and the step's outputs: `scrape=true` hands the scrape on. */
    return { ...result, log: read('log'), output: read('output') };
  };
  const green: Checks = [
    { name: 'build', bucket: 'pass', workflow: 'CI' },
    { name: 'data-guard', bucket: 'pass', workflow: 'CI' },
    { name: 'smoke', bucket: 'pass', workflow: 'Live smoke test' },
    { name: 'automerge', bucket: 'skipping', workflow: 'Dependabot auto-merge' },
  ];
  const smoke = green.filter((c) => c.name === 'smoke');

  // A commit status, or a check run made through the API, carries no workflow's name.
  it('merges no smoke check that the smoke workflow did not run', () => {
    const forged = green.map((c) => (c.name === 'smoke' ? { name: 'smoke', bucket: 'pass' } : c));
    const { status, log } = run([forged]);
    expect(status).toBe(1);
    expect(log).toContain('pr close 7');
    expect(log).not.toContain('pr merge');
  });

  it('waits for the required checks to be listed, not only the smoke test', () => {
    const { status, log } = run([smoke, green]);
    expect(status).toBe(0);
    expect(log.match(/^pr checks /gm)).toHaveLength(2);
    expect(log).toContain('pr merge 7');
  });

  // An empty --match-head-commit pins nothing: gh merges whatever the head is.
  it.each([
    ['head', { SHA: '' }],
    ['PR', { PR: '' }],
  ])('merges nothing without a %s to pin it to', (_, env) => {
    const { status, log, output } = run([green], env);
    expect(status).toBe(1);
    expect(log).not.toContain('pr merge');
    expect(output).not.toContain('scrape=');
  });

  it('merges the head the PR job pushed, hands the scrape on, and asks the owners to read it', () => {
    const { status, log, output } = run([green]);
    expect(status).toBe(0);
    const merged = log.indexOf('pr merge 7 --squash --match-head-commit abc123');
    const told = log.indexOf('issue comment 113');
    expect(merged).toBeGreaterThan(-1);
    expect(told).toBeGreaterThan(merged);
    expect(log.slice(told)).toContain('@amis92');
    expect(output).toBe('scrape=true\n');
    // The next steps start it, with the App's token: this one's would start no drift fixer.
    expect(log).not.toContain('workflow run');
  });

  it('waits for the smoke test to finish', () => {
    const pending = green.map((c) => (c.name === 'smoke' ? { ...c, bucket: 'pending' } : c));
    const { status, log } = run([pending, pending, green]);
    expect(status).toBe(0);
    expect(log.match(/^pr checks /gm)).toHaveLength(3);
    expect(log).toContain('pr merge 7');
  });

  it.each([
    [
      'a failed smoke test',
      [
        { name: 'smoke', bucket: 'fail' },
        { name: 'build', bucket: 'pass' },
      ],
    ],
    [
      'a failed build',
      [
        { name: 'smoke', bucket: 'pass' },
        { name: 'build', bucket: 'fail' },
      ],
    ],
    ['no smoke test at all', [{ name: 'build', bucket: 'pass' }]],
    ['checks that never finish', [{ name: 'smoke', bucket: 'pending' }]],
  ])('closes the fix and hands the scrape on, for another run, on %s', (_, checks) => {
    const { status, stdout, log, output } = run([checks]);
    expect(status).toBe(1);
    expect(stdout).toContain('::error title=Not merged::');
    expect(log).toContain('pr close 7');
    expect(output).toBe('scrape=true\n');
    expect(log.slice(log.indexOf('issue comment 113'))).toContain('Reopen #7');
    expect(log).not.toContain('pr merge');
    expect(log).not.toContain('pr ready');
    expect(log).not.toContain('workflow run');
  });

  // Another run would meet the same refusal: a person changes what GitHub asks for.
  it('turns the fix back into a draft when GitHub refuses the merge', () => {
    const { status, stdout, log, output } = run([green], { MERGE_EXIT: '1' });
    expect(status).toBe(1);
    expect(stdout).toContain('GitHub refused the merge');
    expect(log).toContain('pr ready 7 --undo');
    expect(log).not.toContain('pr close');
    expect(output).not.toContain('scrape=');
  });

  it('merges without comments when there is no failure issue', () => {
    const { status, log } = run([green], { ISSUE: '' });
    expect(status).toBe(0);
    expect(log).toContain('pr merge 7');
    expect(log).not.toContain('issue comment');
  });
});
