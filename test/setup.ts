import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { gitEnv } from '../src/ops/open-prs.js';

/**
 * Runs before every test file, to keep the tests off the developer's repository and off
 * GitHub, however they are run.
 *
 * Git: tests create and drive throwaway repositories, and lefthook's pre-push hook runs
 * this suite with the variables git exports to hooks (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, …). Inherited, they point a test's git at the developer's own
 * repository: once, a test's `git init --bare` set `core.bare = true` on it. So the test
 * process drops them all (`gitEnv()`, which the code under test applies too), and git reads
 * an empty global config and no system config, so neither a developer's settings nor a
 * runner's can change what a test sees.
 *
 * GitHub: tests stub the API and `gh`, and a stub that isn't the one used must fail, not
 * reach the real thing. Once, a stub `gh` missing from `PATH` let the real one open two
 * issues on the repository. So `gh` gets a host that can't resolve and an empty config
 * (no stored login), no GitHub token is set, and the REST API root can't resolve either:
 * a test that wants GitHub stubs it, with `vi.stubEnv` or a `GitHub` of its own.
 */

const keep = gitEnv();
for (const name of Object.keys(process.env)) if (!(name in keep)) delete process.env[name];
for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])
  delete process.env[name];

const dir = mkdtempSync(join(tmpdir(), 'mfm-test-env-'));
writeFileSync(join(dir, 'gitconfig'), '');
mkdirSync(join(dir, 'gh'));
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  // `.invalid` never resolves (RFC 2606).
  GH_HOST: 'github.invalid',
  GH_CONFIG_DIR: join(dir, 'gh'),
  GH_PROMPT_DISABLED: '1',
  GITHUB_API_URL: 'https://api.github.invalid',
  GITHUB_SERVER_URL: 'https://github.invalid',
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
