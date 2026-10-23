import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { gitEnv } from '../src/ops/git-env.js';

/**
 * Runs before every test file, to keep the tests off the developer's repository, off
 * GitHub and off Anthropic's API, however they are run.
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
 * (no stored login), no GitHub token is set, and the REST API root is a closed port:
 * a test that wants GitHub stubs it, with `vi.stubEnv` or a `GitHub` of its own.
 *
 * Anthropic: the brief's tests stub `fetch`, and no Anthropic key is set, even one the
 * developer exported, so a test that reaches the real API by mistake can't make a billed
 * request.
 */

const keep = gitEnv();
for (const name of Object.keys(process.env)) if (!(name in keep)) delete process.env[name];
for (const name of [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
])
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
  // The REST API at a port nothing listens on: a call is refused at once, not retried
  // against GitHub.
  GITHUB_API_URL: 'http://127.0.0.1:9',
  GITHUB_SERVER_URL: 'https://github.invalid',
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
