import { type ZodType, z } from 'zod';
import { Dataset, Faction, SCHEMA_VERSION, SiteMeta } from './model.js';

/**
 * The JSON Schemas under `schema/`, generated from the zod model with `z.toJSONSchema()`
 * (see "JSON Schema" in specs/data-model.md). `mfm schema` writes them, `mfm check-data`
 * fails when the committed copies differ, and the release attaches them. Pure.
 *
 * They are generated as zod reads (`io: 'input'`): what `Faction.parse()` accepts, so a key
 * the model doesn't list is allowed. Data with an optional field added later still
 * validates against an older schema of the same `schemaVersion`, which is what makes an
 * addition non-breaking. The committed files carry no unknown keys all the same:
 * check-data's canonical check catches one.
 */

/** This repository on GitHub, for links in generated files that leave it. */
export const REPO_URL = 'https://github.com/BSData/wh40k-11e-mfm';

const SPEC = `${REPO_URL}/blob/main/specs/data-model.md`;

const SCHEMAS: Record<string, { schema: ZodType; title: string; description: string }> = {
  'faction.schema.json': {
    schema: Faction,
    title: 'Munitorum Field Manual faction',
    description: `One faction file, data/<slug>.yaml, at schemaVersion ${SCHEMA_VERSION}. See ${SPEC}`,
  },
  'meta.schema.json': {
    schema: SiteMeta,
    title: 'Munitorum Field Manual dataset metadata',
    description: `data/meta.yaml, at schemaVersion ${SCHEMA_VERSION}. See ${SPEC}`,
  },
  'all.schema.json': {
    schema: Dataset,
    title: 'Munitorum Field Manual dataset',
    description: `all.json, a release asset: meta.yaml and every faction file, at schemaVersion ${SCHEMA_VERSION}. See ${SPEC}`,
  },
};

/** Every schema file's name and text, in the order above. */
export function jsonSchemas(): { name: string; text: string }[] {
  return Object.entries(SCHEMAS).map(([name, { schema, title, description }]) => {
    const { $schema, ...rest } = z.toJSONSchema(schema, { io: 'input' });
    return {
      name,
      text: `${JSON.stringify({ $schema, title, description, ...rest }, null, 2)}\n`,
    };
  });
}
