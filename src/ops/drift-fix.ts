import { FAILURE_LABEL } from './failure-issue.js';
import { type GitHub, paginate, request } from './github.js';

/**
 * Whether `drift-fix.yml` runs its agent for a failed scrape (`mfm drift-fix-gate`). The
 * model's key has a small spend limit, so the agent runs at most `MAX_RUNS_PER_OUTAGE`
 * times per outage and only on drift: a scrape run of this repository's `scrape.yml` that
 * failed on parsing, which is when it uploads the `drift` artifact; never while an
 * `agent-fix` PR is open; and, when a failed scrape started it, only while the open
 * scrape-failure issue records fewer drift-fix runs than that. A manual replay skips that
 * last check. The gate records the run it lets through on the issue, before the agent
 * starts. See "The drift fixer" in specs/change-tracking.md.
 */

export const AGENT_FIX_LABEL = 'agent-fix';
/**
 * A fix that merged but left the scrape failing, or that the merge job closed when a check
 * failed, gets another try, up to this many runs: about $6 of the key's $10 at the usual
 * $1-2 a run (0040).
 */
export const MAX_RUNS_PER_OUTAGE = 3;
/** The scrape's failure artifact: the report and the refreshed pages. */
export const DRIFT_ARTIFACT = 'drift';
/** The same from a dry run, which only a manual replay takes. */
export const DRY_RUN_DRIFT_ARTIFACT = 'drift-dry-run';
export const SCRAPE_WORKFLOW = '.github/workflows/scrape.yml';
/** Who writes the marker: the drift-fix workflow's own token. */
export const MARKER_AUTHOR = 'github-actions[bot]';

/**
 * The hidden marker a drift-fix run leaves on the failure issue it ran for. It counts only
 * at the very start of a comment: the scrape's failure reports, which the same account
 * posts, quote the site's text further down.
 */
export const runMarker = (runId: string) => `<!-- drift-fix-run: ${runId} -->`;
const MARKER = /^<!-- drift-fix-run: (\d+) -->/;

interface Run {
  path: string;
  head_branch: string | null;
  conclusion: string | null;
  head_repository: { full_name: string } | null;
}
interface Artifact {
  name: string;
  expired: boolean;
}
interface Pull {
  number: number;
  labels: { name: string }[];
}
interface Issue {
  number: number;
}
interface Comment {
  body?: string;
  user: { login: string } | null;
}

export interface GateInput {
  /** The failed scrape run. */
  runId: string;
  /** The branch this workflow runs on: the scrape run must be on it too. */
  branch: string;
  /** A replay a maintainer started (`workflow_dispatch`), not a failed scrape. */
  manual: boolean;
  /** This drift-fix run, for the issue comment. */
  thisRunUrl: string;
}

export interface Gate {
  run: boolean;
  /** Why, for the log. */
  reason: string;
  /** The open scrape-failure issue, when there is one. */
  issue?: number;
  /** The artifact the agent gets. */
  artifact?: string;
}

const skip = (reason: string): Gate => ({ run: false, reason });

/**
 * Decide, and record a run it lets through on the open failure issue. The run id is
 * checked here too, since a replay's comes from a maintainer's input.
 */
export async function driftFixGate(gh: GitHub, input: GateInput): Promise<Gate> {
  const { runId, branch, manual, thisRunUrl } = input;
  if (!/^\d+$/.test(runId)) return skip(`Not a run id: ${JSON.stringify(runId)}`);

  const run = await request<Run>(gh, 'GET', `/actions/runs/${runId}`);
  if (run.path.replace(/@.*$/, '') !== SCRAPE_WORKFLOW) {
    return skip(`Run ${runId} is not a ${SCRAPE_WORKFLOW} run: ${run.path}`);
  }
  if (run.head_repository?.full_name !== gh.repo) {
    return skip(`Run ${runId} ran for another repository: ${run.head_repository?.full_name}`);
  }
  if (run.head_branch !== branch) {
    return skip(`Run ${runId} ran on ${run.head_branch}, not on ${branch}`);
  }
  if (run.conclusion !== 'failure') return skip(`Run ${runId} didn't fail: ${run.conclusion}`);

  const accepted = manual ? [DRIFT_ARTIFACT, DRY_RUN_DRIFT_ARTIFACT] : [DRIFT_ARTIFACT];
  const { artifacts } = await request<{ artifacts: Artifact[] }>(
    gh,
    'GET',
    `/actions/runs/${runId}/artifacts?per_page=100`,
  );
  const artifact = artifacts.find((a) => accepted.includes(a.name) && !a.expired);
  if (!artifact) {
    return skip(
      `Run ${runId} has no ${accepted.join(' or ')} artifact: the scrape failed outside parsing (an outage, not drift), or the artifact expired`,
    );
  }

  const open = await paginate<Pull>(gh, '/pulls?state=open&per_page=100');
  const fix = open.find((pr) => pr.labels.some((l) => l.name === AGENT_FIX_LABEL));
  if (fix) return skip(`PR #${fix.number}, labelled ${AGENT_FIX_LABEL}, is still open`);

  const [issue] = await request<Issue[]>(
    gh,
    'GET',
    `/issues?labels=${FAILURE_LABEL}&state=open&sort=created&direction=asc&per_page=1`,
  );
  if (!issue && !manual) {
    return skip(`No open ${FAILURE_LABEL} issue to record the run on, so none runs`);
  }
  if (issue && !manual) {
    const comments = await paginate<Comment>(gh, `/issues/${issue.number}/comments?per_page=100`);
    const earlier = comments
      .filter((c) => c.user?.login === MARKER_AUTHOR)
      .map((c) => c.body?.match(MARKER)?.[1])
      .filter((id) => id !== undefined);
    if (earlier.length >= MAX_RUNS_PER_OUTAGE) {
      return skip(
        `${earlier.length} drift-fix runs (${earlier.join(', ')}) already ran for #${issue.number}: at most ${MAX_RUNS_PER_OUTAGE} per outage. Replay one by hand to try again.`,
      );
    }
  }

  if (issue) {
    await request(gh, 'POST', `/issues/${issue.number}/comments`, {
      body: [
        runMarker(runId),
        `The drift-fix agent is drafting a fix for ${gh.server}/${gh.repo}/actions/runs/${runId}: ${thisRunUrl}`,
        '',
        `It runs at most ${MAX_RUNS_PER_OUTAGE} times per outage. To run it again for this failure: \`gh workflow run drift-fix.yml -f run-id=${runId}\``,
      ].join('\n'),
    });
  }
  return {
    run: true,
    reason: `Run ${runId} failed on parsing; the agent gets its ${artifact.name} artifact`,
    ...(issue ? { issue: issue.number } : {}),
    artifact: artifact.name,
  };
}
