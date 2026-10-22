import type { Command } from './command.js';
import { checkDataCommand, refreshFixturesCommand, scrapeCommand } from './data-commands.js';
import { announce, changelogCommand, diff, plan } from './report-commands.js';
import {
  branchData,
  openPrs,
  reportFailureCommand,
  resolveFailureCommand,
} from './workflow-commands.js';

export { type Command, type Io, UsageError } from './command.js';

/** Every subcommand of `mfm`, in the order `mfm --help` lists them. */
export const COMMANDS: Record<string, Command> = {
  scrape: scrapeCommand,
  diff,
  announce,
  plan,
  changelog: changelogCommand,
  'open-prs': openPrs,
  'branch-data': branchData,
  'check-data': checkDataCommand,
  'refresh-fixtures': refreshFixturesCommand,
  'report-failure': reportFailureCommand,
  'resolve-failure': resolveFailureCommand,
};
