import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogIndex, withEntry } from '../src/changelog.js';
import { POINTS_CSV, pointsCsv } from '../src/csv.js';
import { loadFactionDir, loadMeta } from '../src/diff.js';
import { metaToYaml } from '../src/emit.js';
import { SCHEMA_VERSION } from '../src/model.js';
import { jsonSchemas } from '../src/schema.js';

/** The frozen v1.6 dataset, so expectations don't move with data updates. */
export const DATA = fileURLToPath(new URL('./golden/data-v1.6', import.meta.url));

/** `changelog/v1.6.md` of the repository below: two entries, the newer one first. */
export const V16_CHANGELOG = withEntry(
  withEntry(undefined, '1.6', '## [2026-10-14] — MFM v1.6\n\n**30 factions changed**\n'),
  '1.6',
  '## [2026-10-20 → 2026-10-22] — MFM v1.6\n\n**1 faction changed** · see [Names](../specs/data-model.md#names)\n\n### Space Wolves\n\n- Venerable Dreadnought (#2) — moved to Legends\n',
);

/**
 * A repository, under `parent`, holding every generated file as the tools write it: the
 * frozen dataset, brought up to the current `schemaVersion` as a regeneration would (it
 * predates the field), its `points.csv`, the JSON Schemas, `changelog/v1.6.md` and the
 * index. Then `edit` is applied.
 */
export function frozenRepository(parent: string, edit: (root: string) => void = () => {}): string {
  const root = mkdtempSync(join(parent, 'repo-'));
  const data = join(root, 'data');
  cpSync(DATA, data, { recursive: true });
  const meta = loadMeta(data);
  if (!meta) throw new Error(`${DATA}/meta.yaml has no site version`);
  writeFileSync(join(data, 'meta.yaml'), metaToYaml({ ...meta, schemaVersion: SCHEMA_VERSION }));
  writeFileSync(join(data, POINTS_CSV), pointsCsv(loadFactionDir(data)));
  mkdirSync(join(root, 'schema'));
  for (const s of jsonSchemas()) writeFileSync(join(root, 'schema', s.name), s.text);
  // No past releases: a test that wants some writes its own table, and commits.
  mkdirSync(join(root, 'release'));
  writeFileSync(join(root, 'release', 'history.json'), '[]\n');
  mkdirSync(join(root, 'changelog'));
  writeFileSync(join(root, 'changelog', 'v1.6.md'), V16_CHANGELOG);
  writeFileSync(
    join(root, 'DATA-CHANGELOG.md'),
    changelogIndex([{ name: 'v1.6.md', text: V16_CHANGELOG }]),
  );
  edit(root);
  return root;
}
