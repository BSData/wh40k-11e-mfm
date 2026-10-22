import { describe, expect, it } from 'vitest';
import { planUpdate, type UpdatePr, updateStack } from '../src/stack.js';

const pr = (number: number, headRefName: string, baseRefName: string): UpdatePr => ({
  number,
  headRefName,
  baseRefName,
});

describe('updateStack', () => {
  it('chains the update PRs from main up, ignoring everything else', () => {
    const stack = updateStack([
      pr(64, 'mfm/v1.6', 'mfm/v1.5'),
      pr(59, 'dependabot/npm_and_yarn/npm-minor-patch-abc', 'main'),
      pr(63, 'mfm/v1.5', 'main'),
    ]);
    expect(stack.map((p) => p.number)).toEqual([63, 64]);
  });

  it('throws when two update PRs share a base', () => {
    expect(() => updateStack([pr(63, 'mfm/v1.5', 'main'), pr(70, 'mfm/v1.7', 'main')])).toThrow(
      /#63, #70 are all based on main/,
    );
  });
});

describe('planUpdate', () => {
  it('opens a new version branch on main when no update is open', () => {
    expect(planUpdate([], '1.6')).toEqual({ branch: 'mfm/v1.6', base: 'main', below: [] });
  });

  it('force-pushes the open PR for the live version, on its own base', () => {
    expect(planUpdate([pr(63, 'mfm/v1.6', 'main')], '1.6')).toEqual({
      branch: 'mfm/v1.6',
      base: 'main',
      below: [],
    });
    expect(planUpdate([pr(63, 'mfm/v1.5', 'main'), pr(64, 'mfm/v1.6', 'mfm/v1.5')], '1.6')).toEqual(
      { branch: 'mfm/v1.6', base: 'mfm/v1.5', below: [63] },
    );
  });

  it('stacks a new version on the open PR instead of rebuilding it (the v1.5 → v1.6 loss)', () => {
    expect(planUpdate([pr(63, 'mfm/v1.5', 'main')], '1.6')).toEqual({
      branch: 'mfm/v1.6',
      base: 'mfm/v1.5',
      below: [63],
    });
    expect(planUpdate([pr(63, 'mfm/v1.5', 'main'), pr(64, 'mfm/v1.6', 'mfm/v1.5')], '1.7')).toEqual(
      { branch: 'mfm/v1.7', base: 'mfm/v1.6', below: [63, 64] },
    );
  });

  it('rebuilds the next PR from main once the one below it has merged', () => {
    // GitHub retargets #64 to main when mfm/v1.5 is deleted on merge.
    expect(planUpdate([pr(64, 'mfm/v1.6', 'main')], '1.6')).toEqual({
      branch: 'mfm/v1.6',
      base: 'main',
      below: [],
    });
  });

  it('throws when the live version already has a PR below the top', () => {
    expect(() =>
      planUpdate([pr(63, 'mfm/v1.5', 'main'), pr(64, 'mfm/v1.6', 'mfm/v1.5')], '1.5'),
    ).toThrow(/v1\.5, whose PR #63 is not the top of the update stack \(#64, mfm\/v1\.6\)/);
  });

  it('throws when the live version has a PR outside the stack', () => {
    expect(() => planUpdate([pr(70, 'mfm/v1.6', 'mfm/gone')], '1.6')).toThrow(
      /PR #70 is not the top of the update stack\. /,
    );
  });
});
