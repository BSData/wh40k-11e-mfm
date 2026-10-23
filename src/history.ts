import { parse } from 'yaml';
import { z } from 'zod';
import { compareNames, mapNames } from './emit.js';
import { Faction, SCHEMA_VERSION, SiteMeta } from './model.js';
import { nameCase } from './parse/names.js';

/**
 * The releases of `data/` from before releases existed (see "Releases" in
 * specs/data-model.md): a reviewed table, `release/history.json`, of the commits on `main`
 * whose data each update left there, and how to turn each one's `data/` into the current
 * shape. The release workflow publishes every one it doesn't find yet, oldest first,
 * before the current release. Pure: text in, data out; `src/ops/git.ts` reads the commits.
 */

/** Where the table is, in the repository. */
export const HISTORY_FILE = 'release/history.json';

/** A release tag: `mfm-v<version>+<YYYY-MM-DD>`, and `.<n>` for a later entry that day. */
export const TAG = /^mfm-v[0-9]+(\.[0-9]+)*\+[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$/;

export const HistoryEntry = z
  .object({
    tag: z.string().regex(TAG),
    /** The commit on `main` whose `data/` the release holds. */
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** The PR that left that data there; `null` for the baseline, which had none. */
    pr: z.number().int().positive().nullable(),
    version: z.string().regex(/^[0-9]+(\.[0-9]+)*$/),
    title: z.string().min(1),
    /** The headings, in `changelog/v<version>.md`, of the entries that are its notes. */
    entries: z.array(z.string().regex(/^## \[[^\]]+\]/)),
    /** The notes when no changelog entry describes the commit (the baseline). */
    notes: z.string().min(1).optional(),
    /** Whether the data is in schema 1, from before #41, and is converted. */
    schema1: z.boolean(),
    /** What else a reader of this snapshot should know, as reviewed. */
    caveats: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((e) => e.entries.length > 0 || e.notes !== undefined, {
    message: 'a release needs changelog entries or notes',
  });
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** Parse the table. */
export const parseHistory = (text: string): HistoryEntry[] =>
  z.array(HistoryEntry).parse(JSON.parse(text));

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * A schema-1 faction (before #41) in the current shape, by #41's mapping: a unit's `role`
 * (`leader` or `support`) and `attachTo` become `leaderTo` or `supportTo`, and a
 * detachment's `objective` (a string, or null) becomes `objectives` (a list, empty for
 * null). Anything else that doesn't fit that shape throws, naming where.
 */
export function fromSchema1(raw: unknown, where: string): unknown {
  if (!isObject(raw)) throw new Error(`${where}: not a faction`);
  const f = structuredClone(raw);
  const list = (key: string) => {
    const items = f[key];
    if (!Array.isArray(items) || !items.every(isObject)) throw new Error(`${where}: no ${key}`);
    return items;
  };
  list('detachments').forEach((d, i) => {
    if (!('objective' in d)) throw new Error(`${where}: detachments[${i}] has no objective`);
    const { objective } = d;
    if (objective !== null && typeof objective !== 'string') {
      throw new Error(`${where}: detachments[${i}].objective is not a string or null`);
    }
    Reflect.deleteProperty(d, 'objective');
    Object.assign(d, { objectives: objective === null ? [] : [objective] });
  });
  list('units').forEach((u, i) => {
    const { role, attachTo } = u;
    if (role === undefined && attachTo === undefined) return;
    if ((role !== 'leader' && role !== 'support') || !Array.isArray(attachTo)) {
      throw new Error(
        `${where}: units[${i}] has role ${String(role)} with attachTo ${String(attachTo)}`,
      );
    }
    Reflect.deleteProperty(u, 'role');
    Reflect.deleteProperty(u, 'attachTo');
    u[role === 'leader' ? 'leaderTo' : 'supportTo'] = attachTo;
  });
  return f;
}

/** The keys of `raw` that `parsed` doesn't have: what a parse would drop silently. */
function dropped(raw: unknown, parsed: unknown, path: string): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    return raw.flatMap((r, i) => dropped(r, parsed[i], `${path}[${i}]`));
  }
  if (!isObject(raw) || !isObject(parsed)) return [];
  return Object.keys(raw).flatMap((k) =>
    k in parsed ? dropped(raw[k], parsed[k], `${path}.${k}`) : [`${path}.${k}`],
  );
}

/** `schema.parse(raw)`, failing on any key the schema would drop. */
function strictly<T>(schema: z.ZodType<T>, raw: unknown, where: string): T {
  const parsed = schema.parse(raw);
  const keys = dropped(raw, parsed, where);
  if (keys.length > 0) throw new Error(`fields the model doesn't know: ${keys.join(', ')}`);
  return parsed;
}

/** A snapshot of `data/`, in the current shape, at the current `schemaVersion`. */
export interface Snapshot {
  meta: SiteMeta;
  factions: Faction[];
}

/**
 * The `data/` files of a past commit as a current snapshot: each faction converted from
 * schema 1 when `schema1`, then validated against the current model, and `meta.yaml` given
 * the current `schemaVersion`. Fails on a field the model doesn't know, rather than drop it.
 * Files other than YAML (none existed) are left out: the assets are rebuilt from the model.
 */
export function snapshotOf(files: { name: string; text: string }[], schema1: boolean): Snapshot {
  const factions: Faction[] = [];
  let meta: SiteMeta | undefined;
  for (const { name, text } of files) {
    if (!name.endsWith('.yaml')) continue;
    const where = `data/${name}`;
    const raw: unknown = parse(text);
    if (name === 'meta.yaml') {
      if (!isObject(raw)) throw new Error(`${where}: not a mapping`);
      meta = strictly(SiteMeta, { schemaVersion: SCHEMA_VERSION, ...raw }, where);
    } else {
      factions.push(strictly(Faction, schema1 ? fromSchema1(raw, where) : raw, where));
    }
  }
  if (!meta) throw new Error('data/meta.yaml is missing');
  return { meta, factions };
}

/** Every field path a snapshot uses, as `unit.groupTitle`, `meta.muster`, … */
export function fieldsUsed({ meta, factions }: Snapshot): Set<string> {
  const used = new Set(Object.keys(meta).map((k) => `meta.${k}`));
  const add = (kind: string, x: object) => {
    for (const k of Object.keys(x)) used.add(`${kind}.${k}`);
  };
  for (const f of factions) {
    add('faction', f);
    for (const d of f.detachments) {
      add('detachment', d);
      for (const e of d.enhancements) add('enhancement', e);
    }
    for (const u of f.units) {
      add('unit', u);
      for (const t of u.pricing) {
        add('tier', t);
        for (const c of t.costs) add('cost', c);
      }
      for (const w of u.wargear ?? []) add('wargear', w);
    }
  }
  return used;
}

/** The distinct names of a snapshot the current Names rule (#88) writes otherwise, sorted. */
export function namesCasedOtherwise({ factions }: Snapshot): string[] {
  const otherwise = new Set<string>();
  for (const f of factions) {
    mapNames(f, (name) => {
      if (nameCase(name.toUpperCase()) !== name) otherwise.add(name);
      return name;
    });
  }
  return [...otherwise].sort(compareNames);
}
