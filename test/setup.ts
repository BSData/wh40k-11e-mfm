import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { gitEnv } from '../src/ops/open-prs.js';

/**
 * Runs before every test file. Tests create and drive throwaway git repositories, and
 * lefthook's pre-push hook runs this suite with the variables git exports to hooks
 * (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …). Inherited, they point a test's git at
 * the developer's own repository: once, a test's `git init --bare` set `core.bare = true`
 * on it. So the test process drops them all (`gitEnv()`, which the code under test applies
 * too), and git reads an empty global config and no system config, so neither a
 * developer's settings nor a runner's can change what a test sees.
 */

const keep = gitEnv();
for (const name of Object.keys(process.env)) if (!(name in keep)) delete process.env[name];

const dir = mkdtempSync(join(tmpdir(), 'mfm-gitconfig-'));
writeFileSync(join(dir, 'config'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(dir, 'config'), GIT_CONFIG_NOSYSTEM: '1' });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
