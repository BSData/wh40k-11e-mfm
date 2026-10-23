import { find, type GitHub } from './github.js';

/**
 * The commit a release tag was published at, or `undefined` when there is no release by
 * that tag yet. `mfm release --commit` asks before a real run publishes (see "Releases"
 * in specs/data-model.md).
 */
export async function releasedAt(gh: GitHub, tag: string): Promise<string | undefined> {
  const release = await find<{ target_commitish?: string }>(
    gh,
    `/releases/tags/${encodeURIComponent(tag)}`,
  );
  return release === undefined ? undefined : (release.target_commitish ?? '');
}

/**
 * Whether to publish the release `tag` for `commit`: yes when the tag isn't released yet,
 * no when it is, at this commit (a re-run). A tag released at another commit is an error:
 * the data changed on `main` without a new changelog entry, which is what names a release,
 * and a published release can't be replaced.
 */
export function shouldPublish(tag: string, commit: string, released: string | undefined): boolean {
  if (released === undefined) return true;
  if (released === commit) return false;
  throw new Error(
    `${tag} is already released, at ${released || 'an unknown commit'}, not ${commit}. A release ` +
      'is named after the newest entry in changelog/v<version>.md, so this commit changed data/ ' +
      'without adding one. Add an entry for the change (see "Releases" in specs/data-model.md).',
  );
}
