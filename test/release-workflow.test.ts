import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TAG } from '../src/history.js';

/**
 * The parts of `.github/workflows/release.yml` that decide something, run here. The
 * `publish` job runs no project code (see "Releases" in specs/data-model.md), so what it
 * decides is in the workflow: a jq program that `gh api --jq` applies, and the script that
 * publishes the plan. They run here as they are, with jq and bash, and a stub `gh`. Both
 * are on GitHub's runners; without them, these skip.
 */

const hasJq = spawnSync('jq', ['--version']).status === 0;
const hasBash = spawnSync('bash', ['-c', 'command -v jq']).status === 0;

interface Step {
  name?: string;
  run?: string;
  env?: { TAG_PATTERN?: string; LATER_RELEASE_CHANGES?: string };
}
interface Job {
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}

const workflow = parse(
  readFileSync(fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url)), 'utf8'),
) as { jobs: { publish?: Job; 'release-assets'?: Job } };
const publish = workflow.jobs.publish;
const step = publish?.steps.find((s) => s.name === 'Publish the releases');
const env = step?.env ?? {};
const filter = env.LATER_RELEASE_CHANGES ?? '';

/** The filter over a compare API response, printed as `gh api --jq` prints it. */
const laterChanges = (compare: unknown): string =>
  execFileSync('jq', ['-r', filter], { input: JSON.stringify(compare) })
    .toString()
    .trim();

const file = (filename: string, previous_filename?: string) => ({
  filename,
  ...(previous_filename ? { previous_filename } : {}),
});

describe('the release workflow', () => {
  it('publishes from one step, with the tag pattern src/history.ts uses', () => {
    expect(step?.run).toBeDefined();
    expect(new RegExp(env.TAG_PATTERN ?? '').source).toBe(TAG.source);
    expect(filter).not.toBe('');
  });

  it('names no job after a required check, and writes from publish alone', () => {
    // CI's `build` and `data-guard` are required on main; a job of the same name here
    // would report under that name, and this workflow runs no tests.
    expect(Object.keys(workflow.jobs).sort()).toEqual(['publish', 'release-assets']);
    expect(workflow.jobs['release-assets']?.permissions).toEqual({ contents: 'read' });
    expect(publish?.permissions).toEqual({ contents: 'write' });
    expect(publish?.if).toContain("github.event_name != 'pull_request'");
    expect(publish?.if).toContain("github.ref == 'refs/heads/main'");
    expect(publish?.if).toContain('!inputs.dry-run');
  });
});

describe.skipIf(!hasJq)('LATER_RELEASE_CHANGES, the latest decision', () => {
  it('counts nothing when main is the released commit', () => {
    expect(laterChanges({ status: 'identical', files: [] })).toBe('0');
  });

  it('counts nothing for later commits that leave data/ and changelog/ alone', () => {
    const compare = {
      status: 'ahead',
      files: [file('README.md'), file('.github/workflows/ci.yml'), file('src/scrape.ts')],
    };
    expect(laterChanges(compare)).toBe('0');
  });

  it('counts a later change to data/ or changelog/, so the release is not latest', () => {
    const compare = {
      status: 'ahead',
      files: [file('README.md'), file('data/necrons.yaml'), file('changelog/v1.7.md')],
    };
    expect(laterChanges(compare)).toBe('2');
    // Prefixes, not substrings: a file named like them elsewhere doesn't count.
    expect(laterChanges({ status: 'ahead', files: [file('test/data/x.yaml')] })).toBe('0');
  });

  it('counts a rename at both ends', () => {
    expect(laterChanges({ status: 'ahead', files: [file('old/x.yaml', 'data/x.yaml')] })).toBe('1');
  });

  it.each(['behind', 'diverged'])('is unknown when main is %s the commit', (status) => {
    expect(laterChanges({ status, files: [] })).toBe('unknown');
  });

  it('is unknown when the file list may be cut short', () => {
    const files = Array.from({ length: 300 }, (_, i) => file(`docs/${i}.md`));
    expect(laterChanges({ status: 'ahead', files })).toBe('unknown');
    expect(laterChanges({ status: 'ahead', files: files.slice(1) })).toBe('0');
  });

  it('counts nothing when the response has no file list', () => {
    expect(laterChanges({ status: 'identical' })).toBe('0');
  });
});

describe.skipIf(!hasBash)('the publish script', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'mfm-publish-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  /** A path as bash takes it, on Windows (Git Bash) too. */
  const posix = (path: string) => path.replaceAll('\\', '/');

  const COMMIT = 'c'.repeat(40);
  const T1 = '1'.repeat(40);
  const T2 = '2'.repeat(40);
  const TABLE = [
    { tag: 'mfm-v1.0+2026-06-17', commit: T1 },
    { tag: 'mfm-v1.0+2026-06-22', commit: T2 },
  ];

  /**
   * A stand-in for gh: it records each call, one per line, serves the history table and
   * the compare response from files, and fails `release create` for the tag in `fail`.
   */
  const STUB_GH = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$STUB/calls"
if [ "$1" = api ]; then
  path= query=
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      -H) shift ;;
      --jq) query=$2; shift ;;
      *) path=$1 ;;
    esac
    shift
  done
  case "$path" in
    */contents/release/history.json*) cat "$STUB/table.json" ;;
    */compare/*)
      [ -f "$STUB/compare.json" ] || { echo 'HTTP 502' >&2; exit 1; }
      jq -r "$query" "$STUB/compare.json" ;;
    *) echo "unexpected: $path" >&2; exit 1 ;;
  esac
elif [ "$1 $2" = 'release create' ]; then
  tag=
  for a in "$@"; do if [ "$a" = -- ]; then seen=1; elif [ -n "\${seen:-}" ]; then tag=$a; break; fi; done
  [ "$tag" != "$(cat "$STUB/fail" 2>/dev/null)" ] || { echo "HTTP 422" >&2; exit 1; }
else
  echo "unexpected: $*" >&2; exit 1
fi
`;

  /**
   * Run the step's script on `plan` (lines of tag, target, kind), with GitHub answering
   * `compare` (none: the call fails); the gh calls it made, and its exit code.
   */
  function publishPlan(
    plan: [string, string, string][],
    opts: { compare?: unknown; fail?: string; table?: unknown } = {},
  ) {
    const dir = mkdtempSync(join(scratch, 'run-'));
    const stub = join(dir, 'stub');
    const bin = join(dir, 'bin');
    const planDir = join(dir, 'release');
    mkdirSync(stub);
    mkdirSync(bin);
    mkdirSync(planDir);
    writeFileSync(join(bin, 'gh'), STUB_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(join(stub, 'table.json'), JSON.stringify(opts.table ?? TABLE));
    writeFileSync(join(stub, 'calls'), '');
    if (opts.compare !== undefined)
      writeFileSync(join(stub, 'compare.json'), JSON.stringify(opts.compare));
    if (opts.fail) writeFileSync(join(stub, 'fail'), opts.fail);
    const lines = plan.map(([tag, target, kind], i) => {
      const n = String(i + 1).padStart(2, '0');
      mkdirSync(join(planDir, n, 'assets'), { recursive: true });
      writeFileSync(join(planDir, n, 'title.txt'), `Title of ${tag}`);
      writeFileSync(join(planDir, n, 'notes.md'), 'Notes.\n');
      writeFileSync(join(planDir, n, 'assets', 'all.json'), '{}\n');
      return `${tag}\t${target}\t${kind}\t${n}\n`;
    });
    writeFileSync(join(planDir, 'plan.tsv'), lines.join(''));
    const result = spawnSync(
      'bash',
      [
        '-c',
        `PATH="$(cygpath -u "$BIN" 2>/dev/null || echo "$BIN"):$PATH"\n${step?.run ?? 'exit 99'}`,
      ],
      {
        env: {
          ...process.env,
          BIN: posix(bin),
          STUB: posix(stub),
          GH_REPO: 'BSData/wh40k-11e-mfm',
          GH_TOKEN: 'stub',
          COMMIT,
          PLAN: posix(planDir),
          TAG_PATTERN: env.TAG_PATTERN ?? '',
          LATER_RELEASE_CHANGES: filter,
        },
        encoding: 'utf8',
      },
    );
    const calls = readFileSync(join(stub, 'calls'), 'utf8').split('\n').filter(Boolean);
    const created = calls
      .filter((c) => c.startsWith('release create'))
      .map((c) => {
        const target = c.match(/--target (\S+)/)?.[1];
        const latest = c.match(/--latest=(\S+)/)?.[1];
        const tag = c.match(/ -- (\S+)/)?.[1];
        return `${tag} ${target === COMMIT ? 'COMMIT' : target?.slice(0, 1)} latest=${latest}`;
      });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, calls, created };
  }

  const history = (n: 0 | 1): [string, string, string] => [
    TABLE[n]?.tag ?? '',
    TABLE[n]?.commit ?? '',
    'history',
  ];
  const current: [string, string, string] = ['mfm-v1.6+2026-10-23', COMMIT, 'current'];

  it('publishes the plan in order: the past releases, never latest, then the current one', () => {
    const run = publishPlan([history(0), history(1), current], {
      compare: { status: 'identical', files: [] },
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.created).toEqual([
      'mfm-v1.0+2026-06-17 1 latest=false',
      'mfm-v1.0+2026-06-22 2 latest=false',
      'mfm-v1.6+2026-10-23 COMMIT latest=true',
    ]);
    expect(run.calls[0]).toBe(
      `api -H Accept: application/vnd.github.raw+json repos/BSData/wh40k-11e-mfm/contents/release/history.json?ref=${COMMIT}`,
    );
    expect(run.calls.find((c) => c.startsWith('release create'))).toContain(
      '--title Title of mfm-v1.0+2026-06-17 --notes-file',
    );
  });

  it('marks the current release not latest when main has a later change to data/', () => {
    const run = publishPlan([current], {
      compare: { status: 'ahead', files: [file('data/necrons.yaml')] },
    });
    expect(run.created).toEqual(['mfm-v1.6+2026-10-23 COMMIT latest=false']);
  });

  it('marks it not latest when the compare call fails', () => {
    const run = publishPlan([current]);
    expect(run.status).toBe(0);
    expect(run.created).toEqual(['mfm-v1.6+2026-10-23 COMMIT latest=false']);
  });

  it('stops at the first release that fails, so the order holds', () => {
    const run = publishPlan([history(0), history(1), current], {
      compare: { status: 'identical' },
      fail: 'mfm-v1.0+2026-06-22',
    });
    expect(run.status).not.toBe(0);
    expect(run.created).toEqual([
      'mfm-v1.0+2026-06-17 1 latest=false',
      'mfm-v1.0+2026-06-22 2 latest=false',
    ]);
  });

  it.each([
    [
      'a past release the table at this commit lacks',
      [history(0), ['mfm-v1.0+2026-06-22', T1, 'history']],
    ],
    ['a current release for another commit', [history(0), ['mfm-v1.6+2026-10-23', T2, 'current']]],
    ['a tag of another shape', [history(0), ['v1.6', COMMIT, 'current']]],
    ['a target that is not a commit', [history(0), ['mfm-v1.6+2026-10-23', 'main', 'current']]],
    ['a kind it does not know', [history(0), ['mfm-v1.6+2026-10-23', COMMIT, 'draft']]],
  ] as [string, [string, string, string][]][])('refuses %s, after what came before', (_, plan) => {
    const run = publishPlan(plan, { compare: { status: 'identical' } });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/::error title=(Not a release|Not in the history table)::/);
    expect(run.created).toEqual(['mfm-v1.0+2026-06-17 1 latest=false']);
  });

  it('publishes nothing for an empty plan', () => {
    const run = publishPlan([]);
    expect(run.status).toBe(0);
    expect(run.created).toEqual([]);
  });
});
