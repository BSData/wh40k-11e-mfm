import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The `brief` job in `.github/workflows/scrape.yml` ("In brief, by a model" in
 * specs/change-tracking.md, docs/decisions/0033): it sits between `scrape` and `publish`,
 * holds the model's key without any dependency code beside it (0022), can't fail the run,
 * and `publish` opens the PR with `mfm diff`'s body when it wrote none.
 */

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: { BRANCH?: string };
  with?: { name?: string; 'body-path'?: string };
  'continue-on-error'?: boolean;
}
interface Job {
  needs?: string[] | string;
  if?: string;
  permissions?: Record<string, string>;
  'continue-on-error'?: boolean;
  steps: Step[];
}

const workflow = parse(
  readFileSync(fileURLToPath(new URL('../.github/workflows/scrape.yml', import.meta.url)), 'utf8'),
) as { jobs: Record<string, Job> };

/** The job named `name`, which the workflow must have. */
function job(name: string): Job {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`scrape.yml has no ${name} job`);
  return found;
}

/** A workflow expression, as the YAML holds it: `${{ <inner> }}`. */
const expression = (inner: string) => `\${{ ${inner} }}`;

/** The step of `steps` that `match` picks, which must be there. */
function step(steps: Step[], match: (s: Step) => boolean): Step {
  const found = steps.find(match);
  if (!found) throw new Error('no such step');
  return found;
}

describe('the brief in the scrape workflow', () => {
  it('writes the brief between the scrape and the PR', () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      'scrape',
      'brief',
      'publish',
      'app-check',
      'announce',
      'report',
    ]);
    expect(job('brief').needs).toBe('scrape');
    expect(job('publish').needs).toEqual(['scrape', 'brief']);
  });

  it("holds the model's key in brief alone, which runs no dependency code", () => {
    const holding = Object.entries(workflow.jobs)
      .filter(([, j]) => JSON.stringify(j).includes('secrets.ANTHROPIC_API_KEY'))
      .map(([name]) => name);
    expect(holding).toEqual(['brief']);

    const brief = job('brief');
    expect(brief.permissions).toEqual({ contents: 'read' });
    expect(brief.steps.filter((s) => s.uses?.startsWith('pnpm/setup@'))).toEqual([]);
    for (const s of brief.steps.filter((s) => s.uses !== undefined)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
    const scripts = brief.steps.flatMap((s) => (s.run === undefined ? [] : [s.run]));
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/^node --experimental-strip-types src\/ops\/brief\.ts /);
    for (const script of scripts) expect(script).not.toMatch(/pnpm|tsx|node_modules|npm|npx/);
  });

  it("can't fail the run, and the PR goes out without it", () => {
    expect(job('brief')['continue-on-error']).toBe(true);

    const publish = job('publish');
    expect(publish.if).toBe(
      expression("!cancelled() && !inputs.dry-run && needs.scrape.result == 'success'"),
    );
    const fetchBrief = step(publish.steps, (s) => s.id === 'brief');
    expect(fetchBrief['continue-on-error']).toBe(true);
    expect(fetchBrief.with?.name).toBe('brief');
    const pr = step(publish.steps, (s) => s.id === 'pr');
    expect(pr.with?.['body-path']).toBe(
      expression(
        "steps.brief.outcome == 'success' && '/tmp/brief/body.md' || '/tmp/update/changelog.md'",
      ),
    );

    expect(job('announce').if).toBe(
      expression(
        "!cancelled() && !inputs.dry-run && needs.publish.result == 'success' && needs.publish.outputs.pr != ''",
      ),
    );
    // A failed `brief` is not a scrape failure.
    expect(job('report').needs).toEqual(['scrape', 'publish', 'announce']);
  });

  it("hands the open PR's body on, for the brief to keep", () => {
    const bundle = step(job('scrape').steps, (s) => s.name === 'Bundle the update');
    expect(bundle.env?.BRANCH).toBe(expression('steps.plan.outputs.branch'));
    expect(bundle.run).toContain('/tmp/pr-data/$BRANCH.body.md');
    expect(bundle.run).toContain('/tmp/update/previous-body.md');
  });
});
