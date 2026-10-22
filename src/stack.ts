import { z } from 'zod';

/**
 * Where a scrape's changes go: which update PR branch to write, and what it's based on.
 * There is one PR per MFM version (`mfm/v<version>`). When GW publishes a new version
 * while the last one's PR is still open, the new PR is stacked on it instead of the open
 * PR being rebuilt into a `main` → new-version diff — the way v1.5's late update was
 * folded into v1.6 (`specs/change-tracking.md`, "One PR per version, stacked").
 *
 * `planUpdate()` is pure; `mfm plan` feeds it the open PRs (`mfm open-prs`) and the
 * scraped `meta.yaml`'s version.
 */

/** An open update PR: its number, its branch and the branch it is based on. */
export const UpdatePr = z.object({
  number: z.number().int(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
});
export type UpdatePr = z.infer<typeof UpdatePr>;

export interface UpdatePlan {
  /** The PR branch to create or force-push. */
  branch: string;
  /** What that branch is based on: the trunk, or the branch of the PR below. */
  base: string;
  /** The open update PRs below it, bottom first: what `gh stack link` chains it onto. */
  below: number[];
}

/** The update branch for an MFM version. */
export function updateBranch(version: string): string {
  return `mfm/v${version}`;
}

/**
 * The open update PRs as a stack: the chain from `trunk` up, each PR based on the branch
 * of the one below. Other PRs (Dependabot's, say) are ignored. Throws on a fork in the
 * chain — two update PRs on one base — since nothing says which one the next goes on.
 */
export function updateStack(prs: readonly UpdatePr[], trunk = 'main'): UpdatePr[] {
  const updates = prs.filter((p) => p.headRefName.startsWith('mfm/'));
  const stack: UpdatePr[] = [];
  let base = trunk;
  // Bounded by the PR count, so a base cycle can't spin forever.
  while (stack.length < updates.length) {
    const [next, ...others] = updates.filter((p) => p.baseRefName === base);
    if (!next) break;
    if (others.length > 0) {
      const nums = [next, ...others].map((p) => `#${p.number}`).join(', ');
      throw new Error(
        `Update PRs ${nums} are all based on ${base}: the update stack forks, so there is ` +
          'no single top to put this scrape on. Close or retarget all but one.',
      );
    }
    stack.push(next);
    base = next.headRefName;
  }
  return stack;
}

/**
 * Plan the PR for a scrape of site version `version`, given the open PRs:
 * - no update PR open: a new `mfm/v<version>` on `trunk`;
 * - the top of the stack is this version's: force-push it, on its current base;
 * - the top is an older version's: a new `mfm/v<version>` stacked on it, which stays as it is.
 * A PR for this version anywhere but the top (the site going back a version, or a PR
 * outside the chain) throws: writing to it would mean rebuilding a PR mid-stack.
 */
export function planUpdate(prs: readonly UpdatePr[], version: string, trunk = 'main'): UpdatePlan {
  const branch = updateBranch(version);
  const stack = updateStack(prs, trunk);
  const top = stack.at(-1);
  if (top?.headRefName === branch) {
    return { branch, base: top.baseRefName, below: stack.slice(0, -1).map((p) => p.number) };
  }
  const existing = prs.find((p) => p.headRefName === branch);
  if (existing) {
    throw new Error(
      `The site is on v${version}, whose PR #${existing.number} is not the top of the ` +
        `update stack${top ? ` (#${top.number}, ${top.headRefName})` : ''}. Rebuilding it ` +
        'would rewrite the PRs above it; sort the stack out by hand.',
    );
  }
  return top
    ? { branch, base: top.headRefName, below: stack.map((p) => p.number) }
    : { branch, base: trunk, below: [] };
}
