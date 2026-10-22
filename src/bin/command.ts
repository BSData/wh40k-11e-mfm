import type { ParseArgsOptionsConfig } from 'node:util';

/**
 * What a subcommand of `mfm` (`src/bin/mfm.ts`) is: its options, its `--help`, and a
 * thin `run` over the modules that do the work. What a command prints on stdout is its
 * result; progress and notes go to stderr. (`scrape` and `refresh-fixtures` log their
 * progress to stdout, as they always have: nothing reads their output.) The commands themselves are in
 * `report-commands.ts`, `workflow-commands.ts` and `data-commands.ts`, listed in
 * `commands.ts`.
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface Command {
  /** One line, for `mfm --help`. */
  summary: string;
  /** The whole `--help` text. */
  help: string;
  options: ParseArgsOptionsConfig;
  /** Exactly how many positional arguments it takes. */
  positionals: number;
  run(values: Values, positionals: string[], io: Io): Promise<number>;
}

/** A command line the command can't run: `mfm` prints it with the command's help. */
export class UsageError extends Error {}

export const text = (values: Values, name: string): string | undefined => {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
};

export const flag = (values: Values, name: string): boolean => values[name] === true;

export const required = (values: Values, name: string): string => {
  const v = text(values, name);
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
};

export const prNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`Not a PR number: ${value}`);
  return Number(value);
};

/** Every value of a repeatable option (`multiple: true`). */
export const list = (values: Values, name: string): string[] => {
  const v = values[name];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};
