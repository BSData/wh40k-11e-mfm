import type { Delta, FactionChanges, NumericDiff } from './collect.js';
import type { RulesChanges } from './rules.js';

/**
 * The detail sections the PR body and the changelog file share: one per changed faction,
 * each change a sub-faction shares with its family listed once, and the Rules section.
 */

export const sgn = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

// The block label already says these are points; the delta's sign says which way.
const deltaLine = (d: Delta) => `${d.display}: ${d.from} → ${d.to} (${sgn(d.to - d.from)})`;
const numericItems = (d: NumericDiff): string[] => [
  ...d.deltas.map(deltaLine),
  ...d.added.map((r) => `➕ ${r.display}: ${r.points} pts`),
  ...d.removed.map((r) => `➖ ${r.display}: was ${r.points} pts`),
];

/** One labelled sub-block of a faction section — `**Unit points:**` and its items. */
interface Block {
  label: string;
  /** Names on one line (`**Units added:** A, B`) rather than a bullet list. */
  inline: boolean;
  items: string[];
}

/** A faction's changes as labelled blocks, in reading order. Empty blocks included. */
function blocksOf(c: FactionChanges): Block[] {
  const names = (label: string, items: string[]): Block => ({ label, inline: true, items });
  const list = (label: string, items: string[]): Block => ({ label, inline: false, items });
  return [
    names('Units added', c.unitsAdded),
    names('Units removed', c.unitsRemoved),
    list('Unit points', numericItems(c.costs)),
    list(
      'Unit pricing re-tiered',
      c.retiered.map((r) => r.text),
    ),
    list('Wargear', numericItems(c.wargear)),
    list(
      'Unit changes',
      c.unitOther.map((o) => o.text),
    ),
    names('Detachments added', c.detsAdded),
    names('Detachments removed', c.detsRemoved),
    list('Enhancements', numericItems(c.enh)),
    list(
      'Detachment changes',
      c.detOther.map((o) => o.text),
    ),
  ];
}

const renderBlocks = (blocks: Block[]): string[] =>
  blocks
    .filter((b) => b.items.length > 0)
    .map((b) =>
      b.inline
        ? `**${b.label}:** ${b.items.join(', ')}`
        : `**${b.label}:**\n${b.items.map((i) => `- ${i}`).join('\n')}`,
    );

/** A heading and its Markdown body: one faction, or the changes a family shares. */
export interface Section {
  /** Bare name, for naming the section elsewhere. */
  name: string;
  /** Heading text — the name, plus any version/parent note. */
  title: string;
  body: string;
}

export const renderSection = (s: Section, level: string): string =>
  `${level} ${s.title}\n\n${s.body}`;

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `A`, `A and B`, `A, B and C`. */
export const listing = (names: string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** A listed change's identity: its block and its exact line. */
const itemKey = (b: Block, item: string): string => `${b.label}\n${item}`;
const itemKeys = (blocks: Block[]): Set<string> =>
  new Set(blocks.flatMap((b) => b.items.map((i) => itemKey(b, i))));

/** `blocks` minus the given changes, and how many that took out. */
function without(blocks: Block[], keys: Set<string>): { blocks: Block[]; dropped: number } {
  let dropped = 0;
  const kept = blocks.map((b) => {
    const items = b.items.filter((i) => !keys.has(itemKey(b, i)));
    dropped += b.items.length - items.length;
    return { ...b, items };
  });
  return { blocks: kept, dropped };
}

function factionSection(c: FactionChanges, blocks: Block[], note?: string): Section {
  if (c.status === 'added')
    return {
      name: c.name,
      title: c.name,
      body: `🆕 **New faction** — ${c.unitCount} units, ${c.detCount} detachments`,
    };
  if (c.status === 'removed') return { name: c.name, title: c.name, body: '🗑 **Removed faction**' };
  const title = c.head.length > 0 ? `${c.name}  _(${c.head.join(', ')})_` : c.name;
  const parts = [...(note ? [note] : []), ...renderBlocks(blocks)];
  // A version/parent bump alone leaves nothing to list — say so, rather than emitting
  // a bare heading that reads like a section the renderer forgot to fill in.
  return {
    name: c.name,
    title,
    body: parts.length > 0 ? parts.join('\n\n') : '_No unit or detachment changes._',
  };
}

/**
 * Every changed faction's section, each change listed once per family: a sub-faction
 * page carries its parent's whole roster, so a parent reprice arrives once per page —
 * in v1.5, 759 of the sub-factions' lines were verbatim copies of a Space Marines line.
 *
 * - A change a sub-faction shares verbatim with its parent is listed under the parent.
 * - A change every changed sub-faction shares, but the parent doesn't, is listed once in
 *   a `<Parent> sub-factions — shared` section, right after the parent's.
 * - Each sub-faction lists what is its own, and says how many of its changes are listed
 *   elsewhere.
 *
 * Presentation only: the tallies behind the table still count each faction in full.
 */
export function sections(changes: FactionChanges[]): Section[] {
  const blocks = new Map(changes.map((c) => [c.name, blocksOf(c)]));
  const notes = new Map<string, string>();
  const extra: { anchor: string; after: boolean; section: Section }[] = [];

  const families = new Map<string, string[]>();
  for (const c of changes)
    if (c.parent && c.status === 'changed')
      families.set(c.parent, [...(families.get(c.parent) ?? []), c.name]);

  for (const [parent, kids] of families) {
    const hasParent = changes.some((c) => c.name === parent && c.status === 'changed');
    const inParent = new Map<string, number>();
    const inShared = new Map<string, number>();

    if (hasParent) {
      const listed = itemKeys(blocks.get(parent) ?? []);
      for (const kid of kids) {
        const r = without(blocks.get(kid) ?? [], listed);
        blocks.set(kid, r.blocks);
        inParent.set(kid, r.dropped);
      }
    }

    const sharedTitle = `${parent} sub-factions — shared`;
    const [first = [], ...rest] = kids.map((kid) => blocks.get(kid) ?? []);
    const common = itemKeys(first);
    for (const bs of rest) {
      const ks = itemKeys(bs);
      for (const k of common) if (!ks.has(k)) common.delete(k);
    }
    if (kids.length >= 2 && common.size > 0) {
      const shared = first.map((b) => ({
        ...b,
        items: b.items.filter((i) => common.has(itemKey(b, i))),
      }));
      for (const kid of kids) {
        const r = without(blocks.get(kid) ?? [], common);
        blocks.set(kid, r.blocks);
        inShared.set(kid, r.dropped);
      }
      const note = `_Identical in ${listing(kids)}, and not a change to ${parent} itself — listed once here rather than in each._`;
      extra.push({
        anchor: hasParent ? parent : (kids[0] ?? parent),
        after: hasParent,
        section: {
          name: sharedTitle,
          title: sharedTitle,
          body: [note, ...renderBlocks(shared)].join('\n\n'),
        },
      });
    }

    const sharers = kids.filter((kid) => (inParent.get(kid) ?? 0) > 0);
    if (sharers.length > 0)
      notes.set(
        parent,
        `_Where ${listing(sharers)} had the identical change, it is listed only here._`,
      );
    for (const kid of kids) {
      const p = inParent.get(kid) ?? 0;
      const s = inShared.get(kid) ?? 0;
      const where = [
        p ? `${plural(p, 'change')} identical to **${parent}**` : '',
        s ? `${p ? s : plural(s, 'change')} under **${sharedTitle}**` : '',
      ].filter(Boolean);
      if (where.length > 0) notes.set(kid, `_Not repeated here: ${where.join(', and ')}._`);
    }
  }

  const out: Section[] = [];
  const place = (name: string, after: boolean) => {
    for (const x of extra) if (x.anchor === name && x.after === after) out.push(x.section);
  };
  for (const c of changes) {
    place(c.name, false);
    out.push(factionSection(c, blocks.get(c.name) ?? [], notes.get(c.name)));
    place(c.name, true);
  }
  return out;
}

/** A code fence longer than any run of backticks in `lines`, so none of them closes it. */
const fenceFor = (lines: string[]): string =>
  '`'.repeat(Math.max(3, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((r) => r.length + 1))));

/**
 * The Rules section, listed before the factions: each changed panel as its changed lines,
 * and a panel that came or went as one line rather than all of its lines. None when no
 * panel changed — a site version change alone is in the summary line.
 */
export function rulesSection(rules: RulesChanges | null): Section[] {
  if (!rules || rules.panels.length === 0) return [];
  const blocks = rules.panels.map((p) => {
    if (p.status === 'added') return `**${p.label}:** added — ${plural(p.size, 'line')}`;
    if (p.status === 'removed') return `**${p.label}:** removed — it had ${plural(p.size, 'line')}`;
    const fence = fenceFor(p.diff);
    return `**${p.label}:**\n\n${fence}diff\n${p.diff.join('\n')}\n${fence}`;
  });
  return [{ name: 'Rules', title: 'Rules', body: blocks.join('\n\n') }];
}
