import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSchemas } from '../../schema.js';
import { type Command, text } from '../command.js';

/** The repository this command ships in. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const command: Command = {
  help: `usage: mfm schema [--out <dir>]

Writes the JSON Schemas generated from the zod model (src/model.ts) into --out:
faction.schema.json, meta.schema.json and all.schema.json. Run it after changing the
model: \`mfm check-data\` fails while schema/ is stale. See "JSON Schema" in
specs/data-model.md.

  --out <dir>  where the schemas go (default: schema/ in the repository this command
               is in, the one \`mfm check-data\` checks)
`,
  options: { out: { type: 'string' } },
  positionals: 0,
  async run(values, _, io) {
    const out = text(values, 'out') ?? join(REPO_ROOT, 'schema');
    mkdirSync(out, { recursive: true });
    const schemas = jsonSchemas();
    for (const s of schemas) writeFileSync(join(out, s.name), s.text);
    io.out(`Wrote ${schemas.map((s) => s.name).join(', ')} to ${out}.\n`);
    return 0;
  },
};
