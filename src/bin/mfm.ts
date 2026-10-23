import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COMMANDS, type Io, UsageError } from './commands.js';

/**
 * `mfm`, the project's one command line: the scrape, the reports an update publishes,
 * the data and fixture chores, and the GitHub chores the scrape workflow runs. The
 * `pnpm` scripts (`pnpm scrape`, `pnpm check-data`, `pnpm refresh-fixtures`) run it too.
 *
 *   pnpm mfm --help
 *   pnpm mfm <command> --help
 *
 * The workflow runs it as `node_modules/.bin/tsx src/bin/mfm.ts <command>`. Results go
 * to stdout or, for step outputs, to the file `--output` names; notes go to stderr.
 */

const stdio: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

function overview(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, cmd]) => `  ${name.padEnd(width)}  ${cmd.summary}`,
  );
  return `usage: mfm <command> [options]\n\nCommands:\n${lines.join('\n')}\n\nRun \`mfm <command> --help\` for a command's options.\n`;
}

/** `argv` without a `--` at `at`: pnpm passes one through as is (`pnpm scrape -- --out x`). */
const dropSeparator = (argv: readonly string[], at: number): string[] =>
  argv[at] === '--' ? [...argv.slice(0, at), ...argv.slice(at + 1)] : [...argv];

/** Run one command line; resolves to the exit code (2 for a usage error). */
export async function main(argv: readonly string[], io: Io = stdio): Promise<number> {
  const [name, ...args] = dropSeparator(dropSeparator(argv, 0), 1);
  if (name === '--help' || name === '-h') {
    io.out(overview());
    return 0;
  }
  const entry = name === undefined ? undefined : COMMANDS[name];
  if (!entry) {
    io.err(`${name === undefined ? '' : `Unknown command: ${name}\n\n`}${overview()}`);
    return 2;
  }
  // Only now is the command's module imported, and with it only what it uses.
  const command = await entry.load();
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { ...command.options, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
    if (values.help === true) {
      io.out(command.help);
      return 0;
    }
    if (positionals.length !== command.positionals) {
      throw new UsageError(
        `expected ${command.positionals} argument${command.positionals === 1 ? '' : 's'}, got ${positionals.length}`,
      );
    }
    return await command.run(values, positionals, io);
  } catch (err) {
    // parseArgs' own errors (an unknown option, a missing value) are usage errors too.
    const usage =
      err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    if (!usage) throw err;
    io.err(`mfm ${name}: ${(err as Error).message}\n\n${command.help}`);
    return 2;
  }
}

// Run when executed, not when imported (tests import `main`). Compared by real path, so a
// symlinked checkout still runs.
const entry = process.argv[1];
if (
  entry &&
  existsSync(entry) &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.stack : err);
      // In Actions, also as an annotation, so a failed step (even a continue-on-error one,
      // like the announcement) says why on the run's summary page.
      // biome-ignore lint/complexity/useLiteralKeys: tsc's noPropertyAccessFromIndexSignature requires the bracket form on process.env, and the two rules disagree.
      if (process.env['GITHUB_ACTIONS'] === 'true') {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`::error::mfm ${process.argv[2] ?? ''}: ${message.replace(/\r?\n/g, ' ')}`);
      }
      process.exitCode = 1;
    },
  );
}
