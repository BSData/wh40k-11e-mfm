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
