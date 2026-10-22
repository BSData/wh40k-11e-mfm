import { type GitHub, paginate, request } from './github.js';

/**
 * The scrape-failure issue: one per outage, not one per day. A failed run while a
 * `scrape-failure` issue is open comments on it instead of opening another, and the
 * next successful run closes it.
 */

export const FAILURE_LABEL = 'scrape-failure';

interface Issue {
  number: number;
}

/**
 * What a failure says: the run's log, then the per-faction report the scrape wrote
 * (`pnpm scrape --report`), or why there is none.
 */
export function failureReport(run: string, details: string): string {
  return [
    `**Run log:** ${run}`,
    '',
    details.trim() ||
      '_No per-faction detail was captured — the run likely failed outside parsing (network, browser launch, the index page itself, or a later step such as planning the update PR). Check the run log._',
    '',
    '---',
    'To fix, follow `.agents/skills/diagnose-parse/SKILL.md`. Each block above is the located parser error (including any unconsumed-content report from the completeness check).',
  ].join('\n');
}

/**
 * Report a failed run: a comment on the oldest open failure issue, or a new issue when
 * none is open. Returns the issue's number.
 */
export async function reportFailure(
  gh: GitHub,
  run: string,
  details: string,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ number: number; created: boolean }> {
  const report = failureReport(run, details);
  const [open] = await request<Issue[]>(
    gh,
    'GET',
    `/issues?labels=${FAILURE_LABEL}&state=open&sort=created&direction=asc&per_page=1`,
  );
  if (open) {
    await request(gh, 'POST', `/issues/${open.number}/comments`, {
      body: `The scheduled MFM scrape failed again.\n\n${report}`,
    });
    return { number: open.number, created: false };
  }
  const issue = await request<Issue>(gh, 'POST', '/issues', {
    title: `Scrape failed (${today})`,
    labels: [FAILURE_LABEL],
    body: `The scheduled MFM scrape failed — the source site markup may have drifted, or a faction stopped parsing.\n\n${report}`,
  });
  return { number: issue.number, created: true };
}

/** After a successful run: say so on every open failure issue, and close it. */
export async function resolveFailure(gh: GitHub, run: string): Promise<number[]> {
  const open = await paginate<Issue>(gh, `/issues?labels=${FAILURE_LABEL}&state=open&per_page=100`);
  for (const issue of open) {
    await request(gh, 'POST', `/issues/${issue.number}/comments`, {
      body: `The scheduled scrape succeeded again: ${run}`,
    });
    await request(gh, 'PATCH', `/issues/${issue.number}`, {
      state: 'closed',
      state_reason: 'completed',
    });
  }
  return open.map((i) => i.number);
}
