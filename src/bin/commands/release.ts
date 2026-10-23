import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkData, readGeneratedFiles } from '../../check-data.js';
import { changelogFile } from '../../diff.js';
import { factionFromYaml, metaFromYaml } from '../../emit.js';
import {
  fieldsUsed,
  HISTORY_FILE,
  parseHistory,
  type Snapshot,
  snapshotOf,
} from '../../history.js';
import { filesAt } from '../../ops/git.js';
import { githubFromEnv } from '../../ops/github.js';
import { writeOutputs } from '../../ops/outputs.js';
import { checkHistorical, checkRelease, isReleased, type Verdict } from '../../ops/release.js';
import { currentRelease, historicalRelease, previousRelease, type Release } from '../../release.js';
import { REPO_URL } from '../../schema.js';
import { type Command, required, text, UsageError } from '../command.js';

/** The repository this command ships in. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const command: Command = {
  help: `usage: mfm release --out <dir> [--commit <sha>] [--root <dir>] [--output <file>]
                   [--today <date>]

Builds every release the repository's data calls for, in the order they are published
(see "Releases" in specs/data-model.md): the past ones listed in ${HISTORY_FILE},
oldest first, each from its commit's data/ (so git needs those commits: a full clone),
then the current one, named by the newest entry in changelog/v<version>.md. Fails,
publishing nothing, unless \`mfm check-data\` passes. Writes into --out:

  plan.tsv           the releases to publish, in order, one per line: the tag, the
                     commit it goes on, "history" or "current", and its directory
  <nn>/title.txt     each release's title, notes and assets, numbered in order
  <nn>/notes.md
  <nn>/assets/*
  summary.md         the whole plan, as printed

Publishing is the workflow's \`gh release create\`, one release at a time.

  --out <dir>      where it all goes: a new or empty directory
  --commit <sha>   the commit the current release is for. The notes link to it, and
                   GitHub (GH_TOKEN, GITHUB_REPOSITORY) is asked which releases exist
                   (see the spec): only the missing ones are planned, and a release
                   that is already there with other data fails the run, as does a
                   current release whose predecessor isn't published. Without it,
                   every release is planned, and GitHub isn't asked.
  --root <dir>     the repository (default: the one this command is in)
  --output <file>  append tag=… and title=… (the current release) to a step-output
                   file, such as $GITHUB_OUTPUT, and with --commit, publish=…
                   (whether any is planned) and reason=…
  --today <date>   the day the past releases are backfilled on, for their notes
                   (default: today, UTC)
`,
  options: {
    out: { type: 'string' },
    commit: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
    today: { type: 'string' },
  },
  positionals: 0,
  async run(values, _, io) {
    const out = required(values, 'out');
    const commit = text(values, 'commit');
    if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) {
      throw new UsageError(`--commit must be a full commit SHA, got: ${commit}`);
    }
    const today = text(values, 'today') ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      throw new UsageError(`--today must be a date, YYYY-MM-DD, got: ${today}`);
    }
    const root = text(values, 'root') ?? REPO_ROOT;

    const problems = checkData(readGeneratedFiles(root));
    if (problems.length > 0) {
      for (const p of problems) io.err(`✗ ${p}\n\n`);
      io.err('mfm release: the generated files are not what the tools write (mfm check-data).\n');
      return 1;
    }
    if (existsSync(out) && readdirSync(out).length > 0) {
      throw new Error(`--out ${out} isn't empty: its plan would be published`);
    }

    // The current data, as committed.
    const dataDir = join(root, 'data');
    const yamls = readdirSync(dataDir).filter((n) => n.endsWith('.yaml'));
    const read = (name: string) => readFileSync(join(dataDir, name), 'utf8');
    const now: Snapshot = {
      meta: metaFromYaml(read('meta.yaml')),
      factions: yamls.filter((n) => n !== 'meta.yaml').map((n) => factionFromYaml(read(n))),
    };
    const ref = commit ?? 'main';
    /** A version's changelog file, and its URL at the release's commit. */
    const changelogOf = (version: string, required = true) => {
      const file = changelogFile(version);
      const there = existsSync(join(root, file));
      if (!there && required) throw new Error(`${file} doesn't exist`);
      return {
        text: there ? readFileSync(join(root, file), 'utf8') : '',
        url: `${REPO_URL}/blob/${ref}/${file}`,
      };
    };

    // Every release, oldest first: the history table's, then the current one.
    const planned: { release: Release; target: string | undefined; kind: string }[] = [];
    const fieldsNow = fieldsUsed(now);
    const history = parseHistory(readFileSync(join(root, HISTORY_FILE), 'utf8'));
    for (const entry of history) {
      const files = (await filesAt(root, entry.commit, 'data')).map((f) => ({
        name: f.name,
        text: f.data.toString('utf8'),
      }));
      let snapshot: Snapshot;
      try {
        snapshot = snapshotOf(files, entry.schema1);
      } catch (err) {
        throw new Error(`${entry.tag} (${entry.commit}): ${(err as Error).message}`);
      }
      const log = changelogOf(entry.version, entry.entries.length > 0);
      const release = historicalRelease({
        entry,
        snapshot,
        changelog: log.text,
        changelogUrl: log.url,
        ...(entry.notesFile
          ? { notesFile: readFileSync(join(root, dirname(HISTORY_FILE), entry.notesFile), 'utf8') }
          : {}),
        fieldsNow,
        today,
      });
      planned.push({ release, target: entry.commit, kind: 'history' });
    }
    const log = changelogOf(now.meta.version);
    const current = currentRelease({ snapshot: now, changelog: log.text, changelogUrl: log.url });
    if (history.some((h) => h.tag === current.tag)) {
      throw new Error(`${current.tag} is both the current release and a row of ${HISTORY_FILE}`);
    }
    planned.push({ release: current, target: commit, kind: 'current' });

    // The release before the current one, outside the table: it must exist already, or a
    // failed or cancelled run's release would be skipped over, and come after this one.
    const versions = readdirSync(join(root, 'changelog'))
      .map((name) => name.match(/^v(.+)\.md$/)?.[1])
      .filter((v): v is string => v !== undefined)
      .map((version) => ({ version, text: changelogOf(version).text }));
    const previous = previousRelease(versions, history, now.meta.version);
    const gh = commit === undefined ? undefined : githubFromEnv();
    if (gh && previous && !history.some((h) => h.tag === previous.tag)) {
      if (!(await isReleased(gh, previous.tag))) {
        throw new Error(
          `${previous.tag}, the release of "${previous.heading}", isn't published, so ` +
            `${current.tag} would come before it. Re-run the release workflow's run for the ` +
            'commit that added that entry, then this one (see "Releases" in specs/data-model.md).',
        );
      }
    }

    const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
    // What GitHub has: each release's verdict, in order.
    const verdicts: (Verdict | undefined)[] = [];
    for (const { release, target, kind } of planned) {
      if (!gh || !target) verdicts.push(undefined);
      else if (kind === 'current') verdicts.push(await checkRelease(gh, release.tag, target));
      else {
        const ours = release.assets.map((a) => ({ name: a.name, sha256: sha256(a.data) }));
        const verdict = await checkHistorical(gh, release.tag, target, ours);
        // Not a failure (see checkHistorical), but worth a look on the run's page.
        // biome-ignore lint/complexity/useLiteralKeys: tsc's noPropertyAccessFromIndexSignature requires the bracket form on process.env, and the two rules disagree.
        if (verdict.reason.includes('differently') && process.env['GITHUB_ACTIONS'] === 'true') {
          io.out(`::warning title=Built differently::${verdict.reason}\n`);
        }
        verdicts.push(verdict);
      }
    }

    // Write each one out, and the plan of those to publish.
    mkdirSync(out, { recursive: true });
    const plan: string[] = [];
    const summary: string[] = [
      `## Release plan: ${planned.length} release${planned.length === 1 ? '' : 's'}, oldest first`,
      '',
      gh ? '' : '_Not checked against GitHub (no `--commit`): every release is listed as planned._',
    ];
    planned.forEach(({ release, target, kind }, i) => {
      const dir = String(i + 1).padStart(2, '0');
      mkdirSync(join(out, dir, 'assets'), { recursive: true });
      writeFileSync(join(out, dir, 'title.txt'), release.title);
      writeFileSync(join(out, dir, 'notes.md'), release.notes);
      for (const a of release.assets) writeFileSync(join(out, dir, 'assets', a.name), a.data);
      const verdict = verdicts[i];
      const publish = verdict?.publish ?? true;
      if (publish) plan.push([release.tag, target ?? '', kind, dir].join('\t'));
      const width = Math.max(...release.assets.map((a) => a.name.length));
      summary.push(
        `### ${i + 1}. \`${release.tag}\`: ${publish ? 'publish' : 'skip'}${verdict ? ` (${verdict.reason})` : ''}`,
        '',
        '```text',
        `target:  ${target ?? '(the commit the workflow runs on)'} (${kind})`,
        `title:   ${release.title}`,
        `latest:  ${kind === 'current' ? 'decided at publish: yes unless a later commit on main changed data/ or changelog/' : 'no'}`,
        ...release.assets.map(
          (a, j) =>
            `${j === 0 ? 'assets:  ' : '         '}${a.name.padEnd(width)}  ${String(a.data.length).padStart(9)} bytes  sha256:${sha256(a.data)}`,
        ),
        ...release.notes
          .split('\n')
          .filter((line) => line.trim() !== '')
          .slice(0, 3)
          .map((line) => (line.length > 100 ? `${line.slice(0, 99)}…` : line))
          .map((line, j) => `${j === 0 ? 'notes:   ' : '         '}${line}`),
        '```',
        '',
      );
    });
    writeFileSync(join(out, 'plan.tsv'), plan.map((l) => `${l}\n`).join(''));
    const printed = `${summary.filter((l, i) => l !== '' || summary[i - 1] !== '').join('\n')}\n`;
    writeFileSync(join(out, 'summary.md'), printed);
    io.out(printed);

    const reason =
      plan.length === 0
        ? 'nothing to publish'
        : `${plan.length} of ${planned.length} releases to publish`;
    io.out(`${reason[0]?.toUpperCase()}${reason.slice(1)}.\n`);
    const output = text(values, 'output');
    if (output) {
      writeOutputs(
        {
          tag: current.tag,
          title: current.title,
          ...(gh ? { publish: String(plan.length > 0), reason } : {}),
        },
        output,
        io.out,
      );
    }
    return 0;
  },
};
