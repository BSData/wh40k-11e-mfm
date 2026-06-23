import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { factionFromYaml } from './emit.js';
import type { Faction, FactionContent } from './model.js';

/**
 * Renders a human-readable changelog from two snapshots of the dataset (the
 * committed YAML vs. a freshly scraped copy). Pure logic in `changelog`; the
 * CLI at the bottom wires it to two directories for use in the scrape workflow.
 */

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/** Flatten a faction's points into stable keys for comparison. */
function priceMap(f: FactionContent): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of f.units) {
    for (const t of u.pricing) {
      const tier = u.pricing.length > 1 ? ` [${t.range}]` : '';
      for (const c of t.costs) {
        const what = c.desc ?? `${c.models} model${c.models === 1 ? '' : 's'}`;
        m.set(`${u.name} — ${what}${c.addon ? ' (add-on)' : ''}${tier}`, c.points);
      }
    }
  }
  for (const d of f.detachments) {
    for (const e of d.enhancements) {
      m.set(`Enhancement · ${d.name} · ${e.name}`, e.points);
    }
  }
  return m;
}

const unitNames = (f: FactionContent) => new Set(f.units.map((u) => u.name));
const detNames = (f: FactionContent) => new Set(f.detachments.map((d) => d.name));

/** Produce changelog lines for a single faction that exists in both snapshots. */
function diffFaction(before: FactionContent, after: FactionContent): string[] {
  const lines: string[] = [];

  if (before.version !== after.version) {
    lines.push(`- Version: ${before.version} → ${after.version}`);
  }

  if (before.parent !== after.parent) {
    lines.push(`- Parent faction: ${before.parent ?? '—'} → ${after.parent ?? '—'}`);
  }

  const oldUnits = unitNames(before);
  const newUnits = unitNames(after);
  for (const u of newUnits) if (!oldUnits.has(u)) lines.push(`- ➕ New unit: ${u}`);
  for (const u of oldUnits) if (!newUnits.has(u)) lines.push(`- ➖ Removed unit: ${u}`);

  const oldDet = detNames(before);
  const newDet = detNames(after);
  for (const d of newDet) if (!oldDet.has(d)) lines.push(`- ➕ New detachment: ${d}`);
  for (const d of oldDet) if (!newDet.has(d)) lines.push(`- ➖ Removed detachment: ${d}`);

  // Detachment attribute changes (for detachments present in both snapshots).
  const beforeDet = new Map(before.detachments.map((d) => [d.name, d]));
  for (const d of after.detachments) {
    const prev = beforeDet.get(d.name);
    if (!prev) continue; // a brand-new detachment is already reported above
    if (prev.unique !== d.unique) {
      lines.push(`- ${d.name} — unique: ${prev.unique ?? '—'} → ${d.unique ?? '—'}`);
    }
    // Per-enhancement Leader grants (the "LEADER:" list attached to an enhancement).
    const prevEnh = new Map(prev.enhancements.map((e) => [e.name, e]));
    for (const e of d.enhancements) {
      const pe = prevEnh.get(e.name);
      if (!pe) continue; // a new enhancement is covered by the points diff below
      const pl = (pe.leaderTo ?? []).join(', ');
      const nl = (e.leaderTo ?? []).join(', ');
      if (pl !== nl) lines.push(`- ${d.name} · ${e.name} — leaderTo: [${pl}] → [${nl}]`);
    }
  }

  const oldPrices = priceMap(before);
  const newPrices = priceMap(after);
  for (const [key, np] of newPrices) {
    const op = oldPrices.get(key);
    if (op === undefined) {
      if (!oldUnits.has(key.split(' — ')[0] as string)) continue; // new unit already reported
      lines.push(`- ➕ ${key}: ${np} pts`);
    } else if (op !== np) {
      lines.push(`- ${key}: ${op} → ${np} pts (${signed(np - op)})`);
    }
  }

  return lines;
}

/** Build a full markdown changelog from two faction snapshots keyed by slug. */
export function changelog(before: FactionContent[], after: FactionContent[]): string {
  const beforeBySlug = new Map(before.map((f) => [f.slug, f]));
  const afterBySlug = new Map(after.map((f) => [f.slug, f]));
  const sections: string[] = [];

  for (const f of [...after].sort((a, b) => a.name.localeCompare(b.name))) {
    const prev = beforeBySlug.get(f.slug);
    if (!prev) {
      sections.push(`### ${f.name}\n- ➕ New faction (${f.units.length} units)`);
      continue;
    }
    const lines = diffFaction(prev, f);
    if (lines.length > 0) sections.push(`### ${f.name}\n${lines.join('\n')}`);
  }
  for (const f of before) {
    if (!afterBySlug.has(f.slug)) sections.push(`### ${f.name}\n- ➖ Removed faction`);
  }

  return sections.length > 0
    ? `## Points changes\n\n${sections.join('\n\n')}\n`
    : 'No points changes detected.\n';
}

/** Load every `<faction>.yaml` (excluding meta.yaml) from a directory. */
export function loadFactionDir(dir: string): Faction[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && f !== 'meta.yaml')
    .map((f) => factionFromYaml(readFileSync(join(dir, f), 'utf8')));
}

// CLI: tsx src/diff.ts <beforeDir> <afterDir>
const isMain = argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1];
if (isMain) {
  const [beforeDir, afterDir] = argv.slice(2);
  if (!beforeDir || !afterDir) {
    console.error('usage: tsx src/diff.ts <beforeDir> <afterDir>');
    process.exit(2);
  }
  const before = loadFactionDir(beforeDir);
  const after = loadFactionDir(afterDir);
  process.stdout.write(changelog(before, after));
}
