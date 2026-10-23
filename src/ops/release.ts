import { find, type GitHub, request } from './github.js';

/**
 * Whether a real run would publish the release: `mfm release --commit` asks GitHub before
 * the workflow's `publish` job runs (see "Releases" in specs/data-model.md).
 */

/** What GitHub has under a tag already: the commit, and whether `data/` there is ours. */
export interface Released {
  /** The commit the tag points at. */
  commit: string;
  /** Whether `data/` at that commit is the same tree as at the commit being released. */
  sameData: boolean;
}

/** The verdict: publish or not, and why, in one line. */
export interface Verdict {
  publish: boolean;
  reason: string;
}

/**
 * Publish a tag nobody has released yet. Don't for one released at this commit (a re-run),
 * or at another commit with the same `data/` (a dry run, or a run after a change outside
 * `data/`). A tag released with other data is an error: `data/` changed without a new
 * changelog entry, which is what names a release, and a published release can't be
 * replaced.
 */
export function verdict(tag: string, commit: string, released: Released | undefined): Verdict {
  if (released === undefined) return { publish: true, reason: `no release is tagged ${tag} yet` };
  if (released.commit === commit) {
    return { publish: false, reason: `${tag} is released already, at this commit` };
  }
  if (released.sameData) {
    return {
      publish: false,
      reason: `data/ is unchanged since ${tag}, released at ${released.commit}`,
    };
  }
  throw new Error(
    `${tag} is released already, at ${released.commit}, with other data than ${commit}. A ` +
      'release is named after the newest entry in changelog/v<version>.md, so data/ changed ' +
      'without a new entry. Add one in a PR (see "Releases" in specs/data-model.md): its merge ' +
      'runs this workflow again.',
  );
}

/** The commit a tag points at, through an annotated tag if need be; `undefined` if no tag. */
async function tagCommit(gh: GitHub, tag: string): Promise<string | undefined> {
  type Ref = { object: { sha: string; type: string } };
  const ref = await find<Ref>(gh, `/git/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref || ref.object.type === 'commit') return ref?.object.sha;
  return (await request<Ref>(gh, 'GET', `/git/tags/${ref.object.sha}`)).object.sha;
}

/** The SHA of the `data/` tree at a commit, if it has one. */
async function dataTree(gh: GitHub, commit: string): Promise<string | undefined> {
  type Tree = { tree: { path: string; type: string; sha: string }[] };
  const { tree } = await request<Tree>(gh, 'GET', `/git/trees/${commit}`);
  return tree.find((e) => e.path === 'data' && e.type === 'tree')?.sha;
}

/** Ask GitHub what is released under `tag`, and give the verdict for `commit`. */
export async function checkRelease(gh: GitHub, tag: string, commit: string): Promise<Verdict> {
  const release = await find<object>(gh, `/releases/tags/${encodeURIComponent(tag)}`);
  if (release === undefined) return verdict(tag, commit, undefined);
  const at = await tagCommit(gh, tag);
  if (at === undefined) throw new Error(`${tag} has a release but no tag`);
  if (at === commit) return verdict(tag, commit, { commit: at, sameData: true });
  const [theirs, ours] = await Promise.all([dataTree(gh, at), dataTree(gh, commit)]);
  return verdict(tag, commit, { commit: at, sameData: theirs !== undefined && theirs === ours });
}
