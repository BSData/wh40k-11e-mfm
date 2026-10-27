import { compareNames } from '../emit.js';
import { BRIEF_MARKER, BRIEF_ROOM } from '../ops/brief.js';
import { attentionSection, collectAttention } from './attention.js';
import { collectChanges, type FactionChanges, type Snapshot } from './collect.js';
import {
  changelogFile,
  type RenderOpts,
  updateTitle,
  updateVersion,
  updateWindow,
  windowLabel,
} from './naming.js';
import { collectRules, type RulesChanges } from './rules.js';
import {
  listing,
  plural,
  renderSection,
  rulesSection,
  type Section,
  sections,
  sgn,
} from './sections.js';
import { sharedHead, tallies, totals } from './tally.js';

/**
 * The two Markdown renderings of an update: `changelog()`, the PR body (folded once it is
 * long, and shortened to fit GitHub's PR body limit less the room kept for the brief a
 * model may write above the changelog), and `changelogEntry()`, the same entry in full for
 * the version's file under `changelog/`.
 */

/** "+2 -1 ~7" — added / removed / changed in place — or "—" when nothing moved. */
const counts = (added: number, removed: number, changed = 0): string => {
  const parts: string[] = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`-${removed}`);
  if (changed) parts.push(`~${changed}`);
  return parts.length > 0 ? parts.join(' ') : '—';
};

/** The table's Points cell: "▲3 ▼1 (-25)", or "—" when nothing was repriced. */
const pointsCell = (t: { up: number; down: number; net: number }): string => {
  const arrows = [t.up ? `▲${t.up}` : '', t.down ? `▼${t.down}` : ''].filter(Boolean);
  return arrows.length > 0 ? `${arrows.join(' ')} (${sgn(t.net)})` : '—';
};

const LEGEND =
  '_`+` added · `-` removed · `~` changed in place · ▲ raised · ▼ cut (net in brackets)_';

/** The summary line + per-faction table shown at the top of the changelog. */
function summary(changes: FactionChanges[], rules: RulesChanges | null): string {
  const t = totals(changes, rules);
  const { news, gone, rA, rR, rC, uA, uR, uC, dA, dR, dC, up, down, net, changed, retiered } = t;
  // An MFM revision bumps every faction's version at once. That is a fact about the
  // update, not about any one faction, so when the note is universal it belongs in this
  // line — tagging it onto rows instead would read as "these are the ones that bumped".
  const shared = sharedHead(changes);

  const clauses = [
    changes.length > 0
      ? `**${changes.length} faction${changes.length === 1 ? '' : 's'} changed**`
      : '**No faction changes**',
  ];
  // A schema bump breaks readers of the files, so it comes first (specs/data-model.md).
  if (rules?.schema) clauses.push(`\`schemaVersion\` ${rules.schema}`);
  if (shared) clauses.push(`all ${shared}`);
  // The site version, unless the factions' shared note has already said it.
  if (rules?.version && !shared.split(', ').includes(rules.version))
    clauses.push(`site ${rules.version}`);
  if (news) clauses.push(`${news} new`);
  if (gone) clauses.push(`${gone} removed`);
  if (rA || rR || rC) clauses.push(`rules ${counts(rA, rR, rC)}`);
  if (uA || uR || uC) clauses.push(`units ${counts(uA, uR, uC)}`);
  if (dA || dR || dC) clauses.push(`detachments ${counts(dA, dR, dC)}`);
  if (changed)
    clauses.push(
      `${changed} point change${changed === 1 ? '' : 's'} (▲${up} ▼${down}, net ${sgn(net)} pts)`,
    );
  if (retiered) clauses.push(`${retiered} unit${retiered === 1 ? '' : 's'} re-tiered`);
  const line = clauses.join(' · ');

  if (changes.length < 2) return line;
  const rows = changes.map((c) => {
    const x = tallies(c);
    const mark = c.status === 'added' ? ' 🆕' : c.status === 'removed' ? ' 🗑' : '';
    // A version/parent note the faction does *not* share with the rest is part of what
    // changed for it, so it belongs in its row — a row with nothing else in it then has
    // its reason for being listed. When every faction carries the same note it is in
    // the summary line above instead, and repeating it on all 30 rows would be noise.
    const note = !shared && c.head.length > 0 ? ` _(${c.head.join(', ')})_` : '';
    const name = `${mark ? `**${c.name}**` : c.name}${mark}${note}`;
    return `| ${name} | ${counts(x.uA, x.uR, x.uC)} | ${counts(x.dA, x.dR, x.dC)} | ${pointsCell(x)} |`;
  });
  const table = `| Faction | Units | Detachments | Points |\n| --- | --- | --- | --- |\n${rows.join('\n')}`;
  return `${line}\n\n${table}\n\n${LEGEND}`;
}

/** Detail bodies longer than this fold into a collapsed `<details>` block. */
const FOLD_AFTER_LINES = 50;

/**
 * GitHub's cap on a PR body, in characters. `create-pull-request` enforces it by cutting
 * the body off mid-line, with only a warning in the run log — v1.5's lost sixteen
 * factions that way — so the renderer keeps under it instead.
 */
export const BODY_LIMIT = 65_536;

/**
 * What the body is fitted to: GitHub's limit less `BRIEF_ROOM`, the room kept for the brief
 * a model may write above the changelog (`src/ops/brief.ts`), so putting it in never pushes
 * the body over the limit.
 */
const FIT_TO = BODY_LIMIT - BRIEF_ROOM;

const blurb = (file: string): string =>
  `_Automated Munitorum Field Manual scrape. The YAML diff is canonical; this is the readable summary — the same entry this PR commits to \`${file}\`._`;

/** The blurb of a body with flags and nothing the changelog records (see `changelog()`). */
const NO_ENTRY =
  '_Automated Munitorum Field Manual scrape. No faction or rules data changed, so this PR commits no changelog entry: the YAML diff, in `meta.yaml` only, is the whole change._';

/**
 * Collapse a long per-faction detail body behind a `<details>` toggle, so the summary
 * and table stay readable without scrolling past hundreds of bullets. GitHub renders
 * Markdown inside `<details>` as long as a blank line follows `<summary>`.
 */
function fold(detail: string, factions: number): string {
  const lines = detail.split('\n').length;
  if (lines <= FOLD_AFTER_LINES) return detail;
  // A rules-only update has no factions to count.
  const [title, what] =
    factions > 0
      ? ['Per-faction detail', `${factions} faction${factions === 1 ? '' : 's'}, ${lines} lines`]
      : ['Detail', `${lines} lines`];
  return `<details>\n<summary><strong>${title}</strong> — ${what}</summary>\n\n${detail}\n\n</details>`;
}

/**
 * The PR body within `FIT_TO` (`BODY_LIMIT` less the room for the brief): whole when it
 * fits, otherwise with faction sections replaced by a one-line stub, largest first — so the
 * most factions keep their detail — until it does. A stub keeps its heading; a note under
 * the table names every shortened section and the file that has them in full.
 */
function fitted(
  head: string,
  summaryText: string,
  all: Section[],
  factions: number,
  file: string,
): string {
  const stub = (s: Section): Section => ({
    ...s,
    body: `_${plural(s.body.split('\n').length, 'line')} left out to fit GitHub's PR body limit — the full section is in \`${file}\`._`,
  });
  const build = (shown: Section[], cut: string[]): string => {
    const note =
      cut.length > 0
        ? `\n\n> [!NOTE]\n> Shortened to fit GitHub's ${BODY_LIMIT.toLocaleString('en-US')}-character PR body limit: ${listing(cut.map((n) => `**${n}**`))}. The complete entry is in \`${file}\`, committed by this PR.`
        : '';
    const detail =
      shown.length > 0
        ? `\n\n---\n\n${fold(shown.map((s) => renderSection(s, '##')).join('\n\n'), factions)}`
        : '';
    return `${head}\n\n${summaryText}${note}${detail}\n`;
  };

  let shown = all;
  let body = build(shown, []);
  const cut: string[] = [];
  const largest = [...all].sort(
    (a, b) => b.body.length - a.body.length || compareNames(a.name, b.name),
  );
  for (const s of largest) {
    if (body.length <= FIT_TO) return body;
    cut.push(s.name);
    shown = shown.map((x) => (x === s ? stub(x) : x));
    // Named in page order, not in the order they were cut.
    body = build(
      shown,
      all.filter((x) => cut.includes(x.name)).map((x) => x.name),
    );
  }
  // Only reachable with hundreds of factions: even the stubs don't fit.
  return body.length <= FIT_TO
    ? body
    : build(
        [],
        all.map((x) => x.name),
      );
}

/** Build a full Markdown changelog (the PR body) from two faction snapshots. */
export function changelog(before: Snapshot[], after: Snapshot[], opts: RenderOpts = {}): string {
  const changes = collectChanges(before, after);
  const rules = collectRules(opts.meta?.before, opts.meta?.after);
  const flags = collectAttention(changes, rules, before, after, opts.meta);
  // A flag alone still makes a body: the index flag can come with no data file changed.
  if (changes.length === 0 && !rules && flags.length === 0) return 'No changes detected.\n';
  const file = changelogFile(updateVersion(after, opts));
  // The warning is part of the head, which fitting the body to GitHub's limit never cuts.
  const warning = attentionSection(flags);
  // Without a data or rules change `mfm changelog` writes no entry, so the blurb can't name one.
  const entry = changes.length > 0 || rules !== null;
  // A body with an entry marks the place for the brief, which a later job may fill (see
  // `src/ops/brief.ts`); the mark is invisible until then. One without has nothing to sum up.
  const above = entry ? `${BRIEF_MARKER}\n\n${blurb(file)}` : NO_ENTRY;
  const head = `# ${updateTitle(before, after, opts)}\n\n${warning ? `${warning}\n\n` : ''}${above}`;
  const all = [...rulesSection(rules), ...sections(changes)];
  return fitted(head, summary(changes, rules), all, changes.length, file);
}

/**
 * One dated entry for the version's changelog file: the same summary, table and
 * per-faction sections as the PR body (sections at `###`), never folded or shortened.
 * `''` when nothing changed. Written by `mfm changelog` on each scrape PR. `date`
 * defaults to the update's own window (see `updateWindow`), so a re-scrape that finds
 * nothing new rewrites the file byte-identically instead of churning the heading to
 * today and force-pushing the sticky PR. An update with a rules panel change or a faction
 * the site dropped is the exception: that change has no stamp to date it by (see
 * `updateWindow`).
 */
export function changelogEntry(
  before: Snapshot[],
  after: Snapshot[],
  opts: RenderOpts & { date?: string } = {},
): string {
  const changes = collectChanges(before, after);
  const rules = collectRules(opts.meta?.before, opts.meta?.after);
  if (changes.length === 0 && !rules) return '';
  const date = opts.date ?? windowLabel(updateWindow(before, after, opts));
  const version = updateVersion(after, opts);
  const heading = version ? `## [${date}] — MFM v${version}` : `## [${date}]`;
  const detail = [...rulesSection(rules), ...sections(changes)]
    .map((s) => renderSection(s, '###'))
    .join('\n\n');
  return `${heading}\n\n${summary(changes, rules)}${detail ? `\n\n${detail}` : ''}\n`;
}
