import { expect } from 'vitest';

/**
 * Every module `source` loads statically: `import … from '…'`, `export … from '…'`, and a
 * bare `import '…';`, run for its side effects alone.
 */
export const importSpecifiers = (source: string): string[] =>
  [
    ...source.matchAll(/^\s*(?:import\s*|(?:import|export)\b[^;]*?\bfrom\s*)['"]([^'"]+)['"]/gm),
  ].map((m) => m[1] as string);

/**
 * Fails unless `source` loads Node's own modules and nothing else, for the files that run
 * beside a secret under plain Node (`src/ops/brief.ts`, `src/ops/agent-patch.ts`).
 */
export function expectNodeOnly(source: string): void {
  const imports = importSpecifiers(source);
  expect(imports.length).toBeGreaterThan(0);
  for (const specifier of imports) expect(specifier).toMatch(/^node:/);
  expect(source).not.toMatch(/\bimport\s*\(/);
  expect(source).not.toMatch(/\brequire\s*\(/);
}
