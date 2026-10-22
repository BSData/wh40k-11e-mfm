import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factionFromYaml, metaFromYaml, type SiteMeta } from '../emit.js';
import type { Faction } from '../model.js';

/** Reading a snapshot (a `data/` directory) from disk. */

/** A snapshot's `meta.yaml` (the site version and the rules panels), when it has one. */
export function loadMeta(dir: string): SiteMeta | undefined {
  const path = join(dir, 'meta.yaml');
  if (!existsSync(path)) return undefined;
  try {
    const meta: SiteMeta | null = metaFromYaml(readFileSync(path, 'utf8'));
    return meta?.version ? meta : undefined;
  } catch {
    return undefined; // A snapshot without usable meta just goes unnamed.
  }
}

/** The site-wide MFM version recorded in a snapshot's `meta.yaml`, when it has one. */
export const loadVersion = (dir: string): string | undefined => loadMeta(dir)?.version;

/** Load every `<faction>.yaml` (excluding meta.yaml) from a directory. */
export function loadFactionDir(dir: string): Faction[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && f !== 'meta.yaml')
    .map((f) => factionFromYaml(readFileSync(join(dir, f), 'utf8')));
}
