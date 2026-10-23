import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * "No dependency cache" in specs/change-tracking.md: the drift fixer's agent runs code a
 * model wrote in a job on main, which can write cache entries main's runs would restore,
 * so no workflow restores any. pnpm/setup restores its lockfile-verification log even
 * with `cache: false`, unless the lockfile it hashes for the key matches no file.
 *
 * This reads the workflows' own steps only: it can't see a cache a third-party action
 * keeps inside itself. Those were checked at the version pinned, and are checked again on
 * a bump: pnpm/setup v3.1.1 (src/cache-restore/run.ts: no lockfile hash, no cache), and
 * anthropics/claude-code-action v1.0.251, whose only cache is setup-bun's, which it runs
 * with `no-cache: true`.
 */

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const NO_CACHE = '.github/no-dependency-cache';

interface Step {
  uses?: string;
  with?: { cache?: unknown; 'cache-dependency-path'?: unknown; 'package-manager-cache'?: unknown };
}

const steps = readdirSync(root('.github/workflows'))
  .filter((name) => /\.ya?ml$/.test(name))
  .flatMap((name) => {
    const workflow = parse(readFileSync(root(`.github/workflows/${name}`), 'utf8')) as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    return Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
      steps.map((step) => ({ where: `${name} ${job}`, step })),
    );
  });

const using = (action: string) => steps.filter(({ step }) => step.uses?.startsWith(`${action}@`));

describe('no workflow restores a dependency cache', () => {
  it('finds the setup steps, in every workflow that installs', () => {
    expect(using('pnpm/setup').length).toBeGreaterThan(5);
    const files = new Set(using('pnpm/setup').map(({ where }) => where.split(' ')[0]));
    for (const name of ['ci.yml', 'drift-fix.yml', 'release.yml', 'scrape.yml', 'smoke.yml']) {
      expect(files).toContain(name);
    }
  });

  it.each(using('pnpm/setup'))(
    '$where: pnpm/setup hashes no lockfile, so it caches nothing',
    ({ step }) => {
      expect(step.with?.cache).toBe(false);
      expect(step.with?.['cache-dependency-path']).toBe(NO_CACHE);
    },
  );

  it(`never has a ${NO_CACHE} to hash`, () => {
    expect(existsSync(root(NO_CACHE))).toBe(false);
  });

  it.each(using('actions/setup-node'))('$where: setup-node caches nothing', ({ step }) => {
    expect(step.with?.['package-manager-cache']).toBe(false);
    expect(step.with?.cache).toBeUndefined();
  });

  it('uses no cache action', () => {
    expect(using('actions/cache').map(({ where }) => where)).toEqual([]);
    expect(steps.filter(({ step }) => step.uses?.startsWith('actions/cache/'))).toEqual([]);
  });
});

/**
 * "Check what scrape handed over" in `publish` (specs/change-tracking.md, "Workflow
 * integration"): the job that holds the App's key admits the staged update only if it is
 * regular files where an update writes. `scrape` stages `data/` whole, so a file the
 * scraper adds to `data/` (points.csv was one, from #96) has to be admitted here too, or
 * the first real update after it fails with "Not part of an update".
 *
 * The workflow matches `find -printf '%y %p'` lines with bash's `[[ =~ ]]` (POSIX ERE).
 * The pattern is run here as a JavaScript RegExp, which reads the same for the constructs
 * a path allowlist needs; the guard below rejects the ones where the two differ.
 */
describe('publish admits what an update writes', () => {
  interface PublishStep extends Step {
    name?: string;
    run?: string;
  }
  const { jobs } = parse(readFileSync(root('.github/workflows/scrape.yml'), 'utf8')) as {
    jobs: { publish: { steps: PublishStep[] } };
  };
  const script = jobs.publish.steps.find(
    ({ name }) => name === 'Check what scrape handed over',
  )?.run;
  const pattern = script?.match(/^\s*allowed='(.*)'\s*$/m)?.[1];
  const allowed = (entry: string) => new RegExp(pattern ?? '(?!)').test(entry);

  it('finds the check and its pattern', () => {
    expect(pattern).toBeTruthy();
  });

  it('uses only syntax that POSIX ERE and JavaScript read alike', () => {
    // No \d \w \s \b, no backreference or (?...) group, and no {n} count.
    expect(pattern).not.toMatch(/\\[a-zA-Z0-9]|\(\?|\{/);
  });

  // What `find -printf '%y %p'` prints for a directory of the repository: a type letter
  // (d directory, f regular file, l link), then the path from the repository's root.
  const found = (dir: string): string[] => [
    `d ./${dir}`,
    ...readdirSync(root(dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? found(`${dir}/${e.name}`) : [`f ./${dir}/${e.name}`],
    ),
  ];

  it('admits every file the repository holds where an update writes', () => {
    const files = [...found('data'), ...found('changelog')];
    expect(files).toContain('f ./data/points.csv');
    expect(files).toContain('f ./data/meta.yaml');
    expect(files.filter((entry) => !allowed(entry))).toEqual([]);
    expect(allowed('f ./DATA-CHANGELOG.md')).toBe(true);
  });

  it.each([
    'd ./data',
    'd ./changelog',
    'f ./DATA-CHANGELOG.md',
    'f ./data/necrons.yaml',
    'f ./data/tau-empire.yaml',
    'f ./data/meta.yaml',
    'f ./data/points.csv',
    'f ./changelog/v1.6.md',
  ])('admits %s', (entry) => {
    expect(allowed(entry)).toBe(true);
  });

  it.each([
    'f ./data/notes.txt',
    'f ./data/points.csv.bak',
    'f ./data/xpoints.csv',
    'f ./data/Points.csv',
    'f ./data/.hidden.yaml',
    'f ./data/.points.csv',
    'f ./data/sub/points.csv',
    'f ./data/necrons.yaml.orig',
    'l ./data/necrons.yaml',
    'l ./data/points.csv',
    'p ./data/points.csv',
    'd ./data/sub',
    'd ./changelog/sub',
    'd ./.git',
    'f ./.git/config',
    'f ./.hidden',
    'f ./README.md',
    'f ./changelog/notes.md',
    'f ./changelog/.v1.6.md',
    'f ./changelog/v1.6.md.bak',
    'f ./data',
    'd ./DATA-CHANGELOG.md',
    'f ./other/data/points.csv',
  ])('rejects %s', (entry) => {
    expect(allowed(entry)).toBe(false);
  });
});
