# 0012. One update PR per MFM version, stacked

- **Status:** accepted, [#66](https://github.com/BSData/wh40k-11e-mfm/pull/66)
- **Spec:** [change tracking — One PR per version, stacked](../../specs/change-tracking.md#one-pr-per-version-stacked)

## Context
Until v1.6 there was one sticky branch, `mfm/auto-update`, rebuilt from `main` on every
run. That held only while each update merged before GW published the next version. v1.6
broke it: the late v1.5 update (2026-10-02 → 2026-10-05) was still open when v1.6 went
live on 2026-10-14, and that day's run rebuilt the branch as one `main` → v1.6 diff. The
v1.5 entry vanished from `changelog/v1.5.md`, and its 457 point changes were filed under
v1.6. They were split back apart by hand, as two stacked PRs (#63, #64).

## Decision
The branch is named for the version (`mfm/v<version>`), and a new version stacks a new PR
on the open one instead of overwriting it. Each PR is diffed against its base, and its
commit is built on a checkout of that base. Anything the plan can't place (a fork in the
stack, a version going back) fails the run rather than guessing.

## Consequences
An old version's PR is final once the site moves on: the site only shows the current
version, so nothing more can arrive for it. The chain merges bottom-up. It is linked as a
GitHub stacked PR on a best-effort basis, because GitHub doesn't document whether a
workflow's `GITHUB_TOKEN` may create stacks; the base-branch chain works without it, since
GitHub retargets the PR above when the branch below is deleted on merge.
