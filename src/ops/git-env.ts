/**
 * Git's environment, without what would point it at another repository. A module of its
 * own, importing nothing, so the test setup can use it without loading anything else.
 */

/** The variables that tell git which repository to use (`git rev-parse --local-env-vars`). */
const REPO_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

/**
 * The environment without `REPO_ENV`, so the directory git runs in decides the
 * repository. A git hook exports `GIT_DIR`, and a command run from one would otherwise
 * act on the hook's repository instead.
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !REPO_ENV.includes(name)));
}
