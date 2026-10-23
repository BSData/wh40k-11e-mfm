import { type GitHub, paginate, request } from './github.js';

/** A repository label, as the workflow creates it when the repository has none. */
export interface Label {
  name: string;
  color: string;
  description: string;
}

/** On an update PR while a change in it needs attention (see `collectAttention`). */
export const ATTENTION_LABEL: Label = {
  name: 'needs-attention',
  color: 'd93f0b',
  description: 'An update PR with a change the scraper may have misread',
};

/** Label names compare as GitHub compares them, ignoring case. */
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Put `label` on PR `pr` when `on`, creating it in the repository first if it has none,
 * or take it off when not. Reads first and writes only what differs, so a run that finds
 * the PR as it should be writes nothing. Says what it did.
 */
export async function setLabel(
  gh: GitHub,
  pr: number,
  label: Label,
  on: boolean,
): Promise<'added' | 'removed' | 'unchanged'> {
  const current = await paginate<{ name: string }>(gh, `/issues/${pr}/labels?per_page=100`);
  const has = current.find((l) => same(l.name, label.name));
  if (Boolean(has) === on) return 'unchanged';
  if (has) {
    await request(gh, 'DELETE', `/issues/${pr}/labels/${encodeURIComponent(has.name)}`);
    return 'removed';
  }
  const all = await paginate<{ name: string }>(gh, '/labels?per_page=100');
  if (!all.some((l) => same(l.name, label.name))) await request(gh, 'POST', '/labels', label);
  await request(gh, 'POST', `/issues/${pr}/labels`, { labels: [label.name] });
  return 'added';
}
