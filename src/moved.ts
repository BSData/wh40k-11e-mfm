import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Refuses a run of a module that used to be a command (`tsx src/diff.ts …`): those
 * moved to `mfm`, and a module run directly would otherwise do nothing and exit 0, which
 * a script calling it takes for success. Exits 1 naming the command to use instead. Does
 * nothing when the module is imported.
 */
export function movedTo(moduleUrl: string, command: string): void {
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) return;
  if (realpathSync(entry) !== realpathSync(fileURLToPath(moduleUrl))) return;
  console.error(`This is no longer a command: use \`${command}\` (\`${command} --help\`).`);
  process.exit(1);
}
