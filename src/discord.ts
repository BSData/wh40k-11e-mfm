import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  collectChanges,
  type FactionChanges,
  loadFactionDir,
  loadVersion,
  type RenderOpts,
  type Snapshot,
  sharedHead,
  tallies,
  totals,
  updateTitle,
  updateWindow,
} from './diff.js';

/**
 * Renders a dataset diff as a Discord webhook message — the push half of change
 * tracking (`specs/change-tracking.md`). The PR body and `DATA-CHANGELOG.md` are pull
 * media; this is what tells a channel an update landed, without anyone going to look.
 *
 * Built from the same `collectChanges`/`totals` as the Markdown renderers in
 * `src/diff.ts`, so the two can't report different numbers for one update. `announcement()`
 * is pure; `send()` does the one HTTP call, and lives here rather than in the workflow so
 * that the code the tests drive is the code that ships.
 *
 * Shape: one embed — title, the summary totals, then every faction with the number of
 * units and detachments that moved in it.
 *
 * Two things it deliberately does *not* do. It doesn't rank by individual point delta:
 * the biggest single swings in a real update are a dozen near-identical variants of one
 * vehicle, which is noise. And it doesn't rank by net points either — that was the first
 * attempt and it was wrong, because an MFM update reprices unrelated units, so summing
 * their deltas cancels genuine churn (a faction with eight changes can net zero) and the
 * total isn't a quantity anyone plays with. "How much of my faction moved" is the
 * question being asked, so the counts are the answer.
 */

/** Discord's per-embed limits. Exceeding any of them is a 400 from the API. */
const LIMIT = {
  title: 256,
  description: 4096,
  fieldValue: 1024,
  footer: 2048,
  /** Sum of title + description + every field name and value + footer. */
  total: 6000,
} as const;

const SOURCE_URL = 'https://mfm.warhammer-community.com/en';
const FOOTER = 'Unofficial · Warhammer 40,000 and the Munitorum Field Manual are © Games Workshop';

/**
 * Munitorum brass. Fixed, deliberately: Discord reads embed colour as status, and the
 * net direction of an update is a sum over unrelated factions — not good or bad news.
 */
const COLOR = 0xb08d57;

export interface EmbedField {
  name: string;
  value: string;
}

export interface Embed {
  title: string;
  url: string;
  description: string;
  color: number;
  fields: EmbedField[];
  footer: { text: string };
  timestamp: string;
}

export interface DiscordMessage {
  embeds: [Embed];
  /** Faction names are data. Never let one become a ping. */
  allowed_mentions: { parse: [] };
}

export interface AnnounceOpts extends RenderOpts {
  /** The open update PR, when there is one — the embed links to it. */
  prUrl?: string;
  prNumber?: number;
  /** The durable changelog on `main`. */
  changelogUrl?: string;
}

/** Cut to `max` characters, marking the cut when there was one. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * Join what fits of `items` into `max` characters, then say how many were left out.
 * Cutting between names rather than mid-name keeps a trimmed list readable.
 */
function joinToFit(items: string[], max: number, sep = ', '): string {
  const kept: string[] = [];
  let len = 0;
  for (const item of items) {
    const add = (kept.length > 0 ? sep.length : 0) + item.length;
    const after = items.length - kept.length - 1;
    const tail = after > 0 ? `${sep}…and ${after} more` : '';
    if (len + add + tail.length > max) break;
    kept.push(item);
    len += add;
  }
  const left = items.length - kept.length;
  if (kept.length === 0) return clip(`…and ${left} more`, max);
  return left > 0 ? `${kept.join(sep)}${sep}…and ${left} more` : kept.join(sep);
}

/** A faction and how much of it moved. */
interface Moved {
  name: string;
  units: number;
  dets: number;
}

/**
 * The per-faction counts, as a monospace block so the columns line up. Discord renders
 * embed text proportionally, so a plain list of names and numbers doesn't column up and
 * stops being scannable at about four rows.
 */
function movedBlock(rows: Moved[]): string {
  const cell = (n: number) => (n > 0 ? String(n) : '-');
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const unitWidth = Math.max(...rows.map((r) => cell(r.units).length));
  const detWidth = Math.max(...rows.map((r) => cell(r.dets).length));
  const line = (r: Moved) =>
    `${r.name.padEnd(nameWidth)}  ${cell(r.units).padStart(unitWidth)}  ${cell(r.dets).padStart(detWidth)}`;

  const kept = [...rows];
  // The fences and their newlines cost 8 characters; drop rows rather than emit an
  // oversized field, which the API would reject outright — but say how many went.
  const over = () => {
    const left = rows.length - kept.length;
    const tail = left > 0 ? `\n…and ${left} more` : '';
    return kept.map(line).join('\n').length + tail.length + 8 > LIMIT.fieldValue;
  };
  while (kept.length > 1 && over()) kept.pop();
  const left = rows.length - kept.length;
  const body = [...kept.map(line), ...(left > 0 ? [`…and ${left} more`] : [])];
  return ['```', ...body, '```'].join('\n');
}

/** `Units: 118 changed, 2 added` — or nothing at all when none moved. */
function entityPhrase(
  added: number,
  removed: number,
  changed: number,
  noun: string,
): string | null {
  const parts: string[] = [];
  if (changed) parts.push(`${changed} changed`);
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  return parts.length > 0 ? `${noun}: ${parts.join(', ')}` : null;
}

/**
 * The links line under the summary. The changelog link goes to the **PR**, not to
 * `DATA-CHANGELOG.md` on `main`: the announcement fires when the update is detected, so
 * at that moment `main` doesn't contain it yet and the link lands on the previous
 * update. The PR body is this update's changelog, and it stays correct after the merge
 * too. `changelogUrl` is the fallback for a caller with no PR.
 */
function linkLine(opts: AnnounceOpts): string {
  const changelog = opts.prUrl ?? opts.changelogUrl;
  const pr = opts.prUrl && opts.prNumber !== undefined ? ` · PR #${opts.prNumber}` : '';
  return [changelog ? `[Full changelog${pr}](${changelog})` : null, `[MFM](${SOURCE_URL})`]
    .filter((l): l is string => l !== null)
    .join(' · ');
}

/** The summary block: what changed, how much of it moved, and where to read the rest. */
function describe(
  changes: FactionChanges[],
  t: ReturnType<typeof totals>,
  opts: AnnounceOpts,
): string {
  const only = changes.length === 1 ? changes[0] : undefined;
  // A lone faction has no shared note to hoist, but its own note still belongs here —
  // otherwise the single faction that changed is never named in the summary at all.
  const note = only ? only.head.join(', ') : sharedHead(changes);

  const lead = [only ? `**${only.name}** changed` : `**${t.factions} factions changed**`];
  if (note) lead.push(only ? note : `all ${note}`);
  if (t.news) lead.push(`🆕 ${t.news} new`);
  if (t.gone) lead.push(`🗑 ${t.gone} removed`);

  const entities = [
    entityPhrase(t.uA, t.uR, t.uC, 'Units'),
    entityPhrase(t.dA, t.dR, t.dC, 'Detachments'),
  ]
    .filter((e): e is string => e !== null)
    .join(' · ');

  // No net total: summing deltas across unrelated units cancels real churn and isn't a
  // number anyone plays with. How many moved, and which way, is the informative part.
  const points = [
    t.changed
      ? `**${t.changed} point change${t.changed === 1 ? '' : 's'}** — ▲${t.up} raised · ▼${t.down} cut`
      : null,
    t.retiered ? `${t.retiered} unit${t.retiered === 1 ? '' : 's'} re-tiered` : null,
  ]
    .filter((b): b is string => b !== null)
    .join(' · ');

  return [lead.join(' · '), entities, points, '', linkLine(opts)]
    .filter((line, i) => line !== '' || i === 3)
    .join('\n');
}

/**
 * Every faction that moved, with its counts, busiest first — then the ones a global MFM
 * revision swept up without actually touching. Naming those separately is what keeps the
 * counts list honest: an update where all 30 factions bump a version number but only 22
 * change anything should not present 30 equal-looking rows.
 */
function buildFields(changes: FactionChanges[]): EmbedField[] {
  const rows: Moved[] = changes.map((c) => {
    const t = tallies(c);
    return { name: c.name, units: t.uA + t.uR + t.uC, dets: t.dA + t.dR + t.dC };
  });
  // Units first, then detachments — not by their sum, which leaves the units column
  // non-monotonic (a 7 below a 6) and so reads as unsorted to anyone scanning it.
  const moved = rows
    .filter((r) => r.units > 0 || r.dets > 0)
    .sort((a, b) => b.units - a.units || b.dets - a.dets || a.name.localeCompare(b.name));
  const untouched = rows.filter((r) => r.units === 0 && r.dets === 0).map((r) => r.name);

  const fields: EmbedField[] = [];
  if (moved.length > 0) {
    fields.push({ name: 'Units / detachments changed', value: movedBlock(moved) });
  }
  if (untouched.length > 0) {
    fields.push({
      name: 'No unit or detachment changes',
      value: joinToFit(untouched, LIMIT.fieldValue),
    });
  }
  return fields;
}

const embedLength = (e: Embed): number =>
  e.title.length +
  e.description.length +
  e.footer.text.length +
  e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

/**
 * Bring an embed inside Discord's 6000-character budget by dropping the faction lists
 * before touching the summary — a huge update should arrive trimmed, never rejected.
 */
function fitToBudget(embed: Embed): Embed {
  const fields = [...embed.fields];
  while (fields.length > 0 && embedLength({ ...embed, fields }) > LIMIT.total) fields.pop();
  const trimmed = { ...embed, fields };
  if (embedLength(trimmed) <= LIMIT.total) return trimmed;
  const room = LIMIT.total - trimmed.title.length - trimmed.footer.text.length;
  return { ...trimmed, description: clip(trimmed.description, Math.max(0, room)) };
}

/**
 * The webhook message for an update, or `null` when the snapshots are identical — the
 * caller then posts nothing, rather than announcing that nothing happened.
 */
export function announcement(
  before: Snapshot[],
  after: Snapshot[],
  opts: AnnounceOpts = {},
): DiscordMessage | null {
  const changes = collectChanges(before, after);
  if (changes.length === 0) return null;

  // Dated from the update's own window, like the title and the changelog heading, so
  // re-rendering an unchanged update yields a byte-identical message to edit with.
  const { to } = updateWindow(before, after, opts);
  const embed: Embed = {
    title: clip(updateTitle(before, after, opts), LIMIT.title),
    url: opts.prUrl ?? opts.changelogUrl ?? SOURCE_URL,
    description: clip(describe(changes, totals(changes), opts), LIMIT.description),
    color: COLOR,
    fields: buildFields(changes),
    footer: { text: clip(FOOTER, LIMIT.footer) },
    timestamp: `${to}T00:00:00.000Z`,
  };
  return { embeds: [fitToBudget(embed)], allowed_mentions: { parse: [] } };
}

// ---- Sending ------------------------------------------------------------------

/**
 * Validate and normalise the webhook from the environment. A mis-set secret must fail
 * here rather than POST a summary of this repository to whatever host is in the
 * variable — note the exact-host check, which `discord.com.example.invalid` fails.
 */
export function webhookUrl(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    (host !== 'discord.com' && host !== 'discordapp.com') ||
    !url.pathname.startsWith('/api/webhooks/')
  ) {
    throw new Error('DISCORD_WEBHOOK_URL is not a Discord webhook URL');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Post `message`, or edit `messageId` when the update already has one. Returns the id of
 * a **newly posted** message — which the caller records so tomorrow's run edits it —
 * and `undefined` when an existing message was edited instead.
 *
 * Takes an already-validated base URL, so a test can point it at a local server.
 */
export async function send(
  hook: string,
  message: DiscordMessage,
  messageId?: string,
): Promise<string | undefined> {
  const headers = { 'content-type': 'application/json' };
  const body = JSON.stringify(message);

  if (messageId) {
    const edit = await fetch(`${hook}/messages/${messageId}`, { method: 'PATCH', headers, body });
    if (edit.ok) return undefined;
    // The message is gone — deleted in Discord, or the id went stale. Post a fresh one
    // rather than dropping the announcement.
    console.error(`Editing message ${messageId} failed (HTTP ${edit.status}) — posting anew.`);
  }

  // `wait=true` makes Discord return the message it created, which is where the id for
  // the next edit comes from.
  const res = await fetch(`${hook}?wait=true`, { method: 'POST', headers, body });
  if (!res.ok) {
    throw new Error(`Discord rejected the post: HTTP ${res.status} ${await res.text()}`);
  }
  const posted = (await res.json()) as { id?: string };
  if (!posted.id) throw new Error('Discord returned no message id');
  return posted.id;
}

// CLI: tsx src/discord.ts <beforeDir> <afterDir> [--send] [--message-id <id>]
//        [--pr-url <url>] [--pr-number <n>] [--changelog-url <url>] [--today <date>]
// Without --send it prints the payload, which is how you preview one locally. With it,
// stdout carries the new message id and nothing else (logs go to stderr), so the caller
// can record it; an edited message prints nothing.
const isMain = argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1];
if (isMain) {
  const rest = argv.slice(2);
  const dirs: string[] = [];
  const opts: AnnounceOpts = {};
  let sending = false;
  let messageId = '';
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = (): string => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag}`);
      return v;
    };
    if (flag === '--send') sending = true;
    else if (flag === '--message-id') messageId = value();
    else if (flag === '--pr-url') opts.prUrl = value();
    else if (flag === '--pr-number') opts.prNumber = Number(value());
    else if (flag === '--changelog-url') opts.changelogUrl = value();
    else if (flag === '--today') opts.today = value();
    else if (flag?.startsWith('--')) throw new Error(`Unknown option: ${flag}`);
    else if (flag !== undefined) dirs.push(flag);
  }
  const [beforeDir, afterDir] = dirs;
  if (!beforeDir || !afterDir) {
    console.error('usage: tsx src/discord.ts <beforeDir> <afterDir> [--send] …');
    process.exit(2);
  }
  const version = loadVersion(afterDir);
  const message = announcement(
    loadFactionDir(beforeDir),
    loadFactionDir(afterDir),
    version ? { ...opts, version } : opts,
  );

  if (!message) console.error('No data changes — nothing to announce.');
  else if (!sending) process.stdout.write(`${JSON.stringify(message)}\n`);
  else {
    // biome-ignore lint/complexity/useLiteralKeys: tsc's noPropertyAccessFromIndexSignature requires the bracket form on process.env, and the two rules disagree.
    const raw = process.env['DISCORD_WEBHOOK_URL'];
    // No secret configured (a fork, or a repo that hasn't set one up) is not a failure.
    if (!raw) console.error('DISCORD_WEBHOOK_URL is not set — skipping the announcement.');
    else {
      const posted = await send(webhookUrl(raw), message, messageId || undefined);
      if (posted) process.stdout.write(`${posted}\n`);
      console.error(posted ? `Posted message ${posted}.` : `Edited message ${messageId}.`);
    }
  }
}
