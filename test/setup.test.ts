import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/** Whether a real `gh` is installed, to show what it does here if a stub goes missing. */
const hasGh = (() => {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const env = (name: string) => process.env[name];

describe('the test environment (test/setup.ts)', () => {
  it('points gh and the GitHub API at hosts that cannot resolve, with no token', () => {
    expect(env('GH_HOST')).toMatch(/\.invalid$/);
    expect(new URL(env('GITHUB_API_URL') ?? '').hostname).toMatch(/\.invalid$/);
    expect(env('GH_CONFIG_DIR')).toBeTruthy();
    expect(env('GH_TOKEN')).toBeUndefined();
    expect(env('GITHUB_TOKEN')).toBeUndefined();
  });

  it('drops the variables that would point git at another repository', () => {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
      expect(env(name)).toBeUndefined();
    expect(env('GIT_CONFIG_NOSYSTEM')).toBe('1');
  });

  it.skipIf(!hasGh)('makes a real gh, run where a stub was meant, fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mfm-gh-'));
    try {
      const run = promisify(execFile)('gh', ['issue', 'list', '--repo', 'example/none'], {
        cwd: dir,
      });
      await expect(run).rejects.toMatchObject({ code: expect.any(Number) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
