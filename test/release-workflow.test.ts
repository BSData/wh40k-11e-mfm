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
const bashJq = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' });
const hasBash = bashJq.status === 0;
/** jq, as bash finds it. */
const JQ = bashJq.stdout?.trim() ?? 'jq';

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
  run?: string;
  env?: { GH_TOKEN?: string; TAG_PATTERN?: string; LATER_RELEASE_CHANGES?: string };
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
    expect(JSON.stringify(workflow.jobs['release-assets'])).not.toContain('PRIVATE_KEY');
    // publish writes with the App's token alone, which the default token can't stand in
    // for: a tag on a commit whose workflow files differ from main's needs workflows write.
    expect(publish?.permissions).toEqual({ contents: 'read' });
    const mint = publish?.steps?.find((s) =>
      s.uses?.startsWith('actions/create-github-app-token@'),
    );
    expect(mint?.with).toMatchObject({
      'permission-contents': 'write',
      'permission-workflows': 'write',
    });
    expect(
      Object.keys(mint?.with ?? {})
        .filter((k) => k.startsWith('permission-'))
        .sort(),
    ).toEqual(['permission-contents', 'permission-workflows']);
    expect(env.GH_TOKEN?.replace(/\s/g, '')).toBe(['$', '{{steps.token.outputs.token}}'].join(''));
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

  it('counts nothing for an identical main, file list or not, and is unknown for ahead without one', () => {
    expect(laterChanges({ status: 'identical' })).toBe('0');
    expect(laterChanges({ status: 'ahead' })).toBe('unknown');
    expect(laterChanges({ status: 'ahead', files: null })).toBe('unknown');
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
  const CURRENT = 'mfm-v1.6+2026-10-23';
  const TABLE = [
    { tag: 'mfm-v1.0+2026-06-17', commit: T1 },
    { tag: 'mfm-v1.0+2026-06-22', commit: T2 },
  ];

  /**
   * A stand-in for gh. It records each call, one per line, in `calls`; serves the history
   * table and the compare response from files; knows the releases in `published` (lines of
   * tag and commit; a release's id is its line number), adding each one it creates; keeps
   * the latest tag in `latest`, which `make_latest` sets; and fails `release create` for
   * the tag in `fail`.
   */
  const STUB_GH = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$STUB/calls"
published() { # "<id> <commit>" of a published tag, from its URI-encoded form
  n=0
  while read -r t c; do
    n=$((n + 1))
    [ "$(jq -rn --arg s "$t" '$s | @uri')" = "$1" ] && { echo "$n $c"; return 0; }
  done < "$STUB/published"
  return 1
}
if [ "$1" = api ]; then
  path= query= method=GET field=
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      -H) shift ;;
      -X) method=$2; shift ;;
      -f) field=$2; shift ;;
      --jq) query=$2; shift ;;
      *) path=$1 ;;
    esac
    shift
  done
  case "$method $path" in
    'GET '*/contents/release/history.json*) cat "$STUB/table.json" ;;
    'GET '*/compare/*)
      [ -f "$STUB/compare.json" ] || { echo 'HTTP 502' >&2; exit 1; }
      jq -r "$query" "$STUB/compare.json" ;;
    'GET '*/releases/latest) [ -s "$STUB/latest" ] || exit 1; cat "$STUB/latest" ;;
    'GET '*/releases/tags/*)
      found=$(published "\${path##*/}") || { echo 'HTTP 404' >&2; exit 1; }
      [ "$query" = .id ] && echo "\${found% *}" || echo "\${found#* }" ;;
    'PATCH '*/releases/*)
      [ "$field" = make_latest=true ] || { echo "unexpected field: $field" >&2; exit 1; }
      [ ! -f "$STUB/patch-fails" ] || { echo 'HTTP 422' >&2; exit 1; }
      sed -n "\${path##*/}p" "$STUB/published" | cut -d' ' -f1 > "$STUB/latest" ;;
    *) echo "unexpected: $method $path" >&2; exit 1 ;;
  esac
elif [ "$1 $2" = 'release create' ]; then
  tag= target= latest= seen=
  for a in "$@"; do
    case "$a" in --target) next=target ;; --latest=*) latest=\${a#--latest=} ;; esac
    if [ "\${next:-}" = target ] && [ "$a" != --target ]; then target=$a; next=; fi
    if [ "$a" = -- ]; then seen=1; elif [ -n "$seen" ] && [ -z "$tag" ]; then tag=$a; fi
  done
  [ "$tag" != "$(cat "$STUB/fail" 2>/dev/null)" ] || { echo 'HTTP 422' >&2; exit 1; }
  echo "$tag $target" >> "$STUB/published"
  [ "$latest" != true ] || echo "$tag" > "$STUB/latest"
else
  echo "unexpected: $*" >&2; exit 1
fi
`;

  interface Opts {
    /** The compare API's answer; none, and the call fails. */
    compare?: unknown;
    /** A tag `release create` fails for. */
    fail?: string;
    /** The releases GitHub has already: tag and commit. */
    published?: [string, string][];
    /** The latest release's tag. */
    latest?: string;
    /** Whether marking a release latest fails. */
    patchFails?: boolean;
  }

  /**
   * Run the step's script on `plan` (lines of tag, target, kind): its exit code and
   * output, the gh calls it made, the releases it created (tag, commit, latest flag) and
   * the latest tag after it.
   */
  function publishPlan(plan: [string, string, string][], opts: Opts = {}) {
    const dir = mkdtempSync(join(scratch, 'run-'));
    const stub = join(dir, 'stub');
    const bin = join(dir, 'bin');
    const planDir = join(dir, 'release');
    for (const d of [stub, bin, planDir]) mkdirSync(d);
    writeFileSync(join(bin, 'gh'), STUB_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    if (process.platform === 'win32') {
      // A native jq.exe writes CRLF unless told not to; the runner's jq writes LF.
      writeFileSync(join(bin, 'jq'), `#!/usr/bin/env bash\nexec '${JQ}' -b "$@"\n`);
      chmodSync(join(bin, 'jq'), 0o755);
    }
    writeFileSync(join(stub, 'table.json'), JSON.stringify(TABLE));
    writeFileSync(join(stub, 'calls'), '');
    writeFileSync(
      join(stub, 'published'),
      (opts.published ?? []).map(([tag, commit]) => `${tag} ${commit}\n`).join(''),
    );
    writeFileSync(join(stub, 'latest'), opts.latest ?? '');
    if (opts.compare !== undefined) {
      writeFileSync(join(stub, 'compare.json'), JSON.stringify(opts.compare));
    }
    if (opts.fail) writeFileSync(join(stub, 'fail'), opts.fail);
    if (opts.patchFails) writeFileSync(join(stub, 'patch-fails'), '');
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
          CURRENT,
          PAUSE: '0',
          PLAN: posix(planDir),
          TAG_PATTERN: env.TAG_PATTERN ?? '',
          LATER_RELEASE_CHANGES: filter,
        },
        encoding: 'utf8',
      },
    );
    const read = (name: string) => readFileSync(join(stub, name), 'utf8');
    const calls = read('calls').split('\n').filter(Boolean);
    const created = calls
      .filter((c) => c.startsWith('release create'))
      .map((c) => {
        const target = c.match(/--target (\S+)/)?.[1];
        const flag = c.match(/--latest=(\S+)/)?.[1];
        const tag = c.match(/ -- (\S+)/)?.[1];
        return `${tag} ${target === COMMIT ? 'COMMIT' : target?.slice(0, 1)} latest=${flag}`;
      });
    return { ...result, calls, created, latest: read('latest').trim() };
  }

  const history = (n: 0 | 1): [string, string, string] => [
    TABLE[n]?.tag ?? '',
    TABLE[n]?.commit ?? '',
    'history',
  ];
  const current: [string, string, string] = [CURRENT, COMMIT, 'current'];
  const IDENTICAL = { status: 'identical', files: [] };
  /** The two past releases, published already. */
  const PAST: [string, string][] = TABLE.map((t) => [t.tag, t.commit]);

  it('publishes the plan in order: the past releases, never latest, then the current one', () => {
    const run = publishPlan([history(0), history(1), current], { compare: IDENTICAL });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.created).toEqual([
      'mfm-v1.0+2026-06-17 1 latest=false',
      'mfm-v1.0+2026-06-22 2 latest=false',
      'mfm-v1.6+2026-10-23 COMMIT latest=true',
    ]);
    expect(run.latest).toBe(CURRENT);
    expect(run.calls[0]).toBe(
      `api -H Accept: application/vnd.github.raw+json repos/BSData/wh40k-11e-mfm/contents/release/history.json?ref=${COMMIT}`,
    );
    expect(run.calls.find((c) => c.startsWith('release create'))).toContain(
      '--title Title of mfm-v1.0+2026-06-17 --notes-file',
    );
    expect(run.calls).toContain(
      'api repos/BSData/wh40k-11e-mfm/releases/tags/mfm-v1.0%2B2026-06-17 --jq .target_commitish',
    );
  });

  it('marks the current release not latest when main has a later change to data/, and says so', () => {
    const run = publishPlan([current], {
      compare: { status: 'ahead', files: [file('data/necrons.yaml')] },
      published: PAST,
      latest: 'mfm-v1.0+2026-06-22',
    });
    expect(run.status).toBe(0);
    expect(run.created).toEqual(['mfm-v1.6+2026-10-23 COMMIT latest=false']);
    expect(run.latest).toBe('mfm-v1.0+2026-06-22');
    expect(run.stdout).toContain(`::warning title=Not latest::${CURRENT} isn't marked latest`);
  });

  it('publishes but fails when the compare call fails, so a re-run marks it latest', () => {
    const run = publishPlan([current], { published: PAST });
    expect(run.status).toBe(1);
    expect(run.created).toEqual(['mfm-v1.6+2026-10-23 COMMIT latest=false']);
    expect(run.stdout).toContain(
      `::error title=Not latest::couldn't tell whether main has changed`,
    );
    // The re-run: the release is there, the call answers, and it is marked latest.
    const again = publishPlan([current], {
      compare: IDENTICAL,
      published: [...PAST, [CURRENT, COMMIT]],
      latest: 'mfm-v1.0+2026-06-22',
    });
    expect(again.status).toBe(0);
    expect(again.created).toEqual([]);
    expect(again.latest).toBe(CURRENT);
  });

  it('marks an earlier run’s current release latest again when nothing is planned', () => {
    // A change outside data/ merged while that run waited, so it published it not latest.
    const run = publishPlan([], {
      compare: IDENTICAL,
      published: [...PAST, [CURRENT, '9'.repeat(40)]],
      latest: 'mfm-v1.0+2026-06-22',
    });
    expect(run.status).toBe(0);
    // Only make_latest, by the release's id: an immutable release takes no other change.
    expect(run.calls).toContain(
      'api -X PATCH repos/BSData/wh40k-11e-mfm/releases/3 -f make_latest=true',
    );
    expect(run.calls.some((c) => c.startsWith('release edit'))).toBe(false);
    expect(run.latest).toBe(CURRENT);
    const again = publishPlan([], {
      compare: IDENTICAL,
      published: [...PAST, [CURRENT, '9'.repeat(40)]],
      latest: CURRENT,
    });
    expect(again.calls.some((c) => c.includes('-X PATCH'))).toBe(false);
  });

  it('fails, saying what to do, when marking it latest fails', () => {
    const run = publishPlan([], {
      compare: IDENTICAL,
      published: [...PAST, [CURRENT, '9'.repeat(40)]],
      latest: 'mfm-v1.0+2026-06-22',
      patchFails: true,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      `::error title=Not latest::marking ${CURRENT} latest failed: re-run this job, or mark it latest on its release page`,
    );
  });

  it('stops at the first release that fails, so the order holds', () => {
    const run = publishPlan([history(0), history(1), current], {
      compare: IDENTICAL,
      fail: 'mfm-v1.0+2026-06-22',
    });
    expect(run.status).not.toBe(0);
    expect(run.created).toEqual([
      'mfm-v1.0+2026-06-17 1 latest=false',
      'mfm-v1.0+2026-06-22 2 latest=false',
    ]);
  });

  it('leaves what an earlier attempt published, so a re-run of the failed jobs goes on', () => {
    const run = publishPlan([history(0), history(1), current], {
      compare: IDENTICAL,
      published: [[TABLE[0]?.tag ?? '', T1]],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('mfm-v1.0+2026-06-17 is published already');
    expect(run.created).toEqual([
      'mfm-v1.0+2026-06-22 2 latest=false',
      'mfm-v1.6+2026-10-23 COMMIT latest=true',
    ]);
  });

  it('fails on a planned tag published at another commit', () => {
    const run = publishPlan([history(0), current], {
      compare: IDENTICAL,
      published: [[TABLE[0]?.tag ?? '', T2], ...PAST.slice(1)],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('::error title=Released elsewhere::');
    expect(run.created).toEqual([]);
  });

  it.each([
    ['a past release the table lacks', [history(0), ['mfm-v1.0+2026-06-22', T1, 'history']]],
    ['past releases out of the table’s order', [history(1), history(0)]],
    ['a current release for another commit', [history(0), [CURRENT, T2, 'current']]],
    ['a current release of another tag', [history(0), ['mfm-v1.6+2026-10-24', COMMIT, 'current']]],
    ['a release after the current one', [current, history(0)]],
    ['a tag of another shape', [history(0), ['v1.6', COMMIT, 'current']]],
    ['a target that is not a commit', [history(0), [CURRENT, 'main', 'current']]],
    ['a kind it does not know', [history(0), [CURRENT, COMMIT, 'draft']]],
  ] as [string, [string, string, string][]][])('refuses %s, publishing nothing', (_, plan) => {
    const run = publishPlan(plan, { compare: IDENTICAL, published: PAST.slice(1) });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(
      /::error title=(Not a release|Not in the history table|Not in order)::/,
    );
    expect(run.created).toEqual([]);
  });

  it('refuses a plan that leaves out a past release GitHub lacks', () => {
    const run = publishPlan([history(1), current], { compare: IDENTICAL });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      '::error title=Missing release::mfm-v1.0+2026-06-17 is neither published nor planned',
    );
    expect(run.created).toEqual([]);
  });
});
