import { compareNames } from '../emit.js';

/** The name the rules panels' failure goes by in the failures report. */
export const RULES_PANELS_FAILURE = 'rules panels';

/** Render the per-faction parse failures for the scrape workflow's error issue. */
export function failuresReport(failures: { slug: string; error: string }[]): string {
  if (failures.length === 0) return '';
  const blocks = [...failures]
    .sort((a, b) => compareNames(a.slug, b.slug))
    .map((f) => `### ${f.slug}\n\n\`\`\`\n${f.error.trim()}\n\`\`\``);
  const n = failures.length;
  return `## ${n} faction${n === 1 ? '' : 's'} failed to parse\n\n${blocks.join('\n\n')}`;
}

/**
 * The failures a `failuresReport()` lists, read back: each block's heading (a faction's
 * slug, or `RULES_PANELS_FAILURE`) and its error. For the drift fixer, which refreshes
 * the pages of the factions that failed (`mfm refresh-fixtures --failed`). The headings
 * are checked by whoever uses them: the slugs come from the site's index page.
 */
export function readFailuresReport(report: string): { slug: string; error: string }[] {
  return report
    .split(/^### /m)
    .slice(1)
    .map((block) => {
      const end = block.indexOf('\n');
      const slug = (end < 0 ? block : block.slice(0, end)).trim();
      const error = block.match(/^```\n([\s\S]*?)\n```/m)?.[1] ?? '';
      return { slug, error: error.trim() };
    });
}
