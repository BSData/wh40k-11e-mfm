import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkData, readGeneratedFiles } from '../../check-data.js';
import { changelogFile } from '../../diff.js';
import { factionFromYaml, metaFromYaml } from '../../emit.js';
import { githubFromEnv } from '../../ops/github.js';
import { writeOutputs } from '../../ops/outputs.js';
import { releasedAt, shouldPublish } from '../../ops/release.js';
import { buildRelease } from '../../release.js';
import { REPO_URL } from '../../schema.js';
import { type Command, required, text, UsageError } from '../command.js';

/** The repository this command ships in. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const command: Command = {
  help: `usage: mfm release --assets <dir> --notes-file <file> [--commit <sha>]
                   [--root <dir>] [--output <file>]

Builds the release of the repository's data (see "Releases" in specs/data-model.md):
its tag, mfm-v<version>+<the last day of the newest entry in changelog/v<version>.md>,
its title, its notes (that entry), and its assets: all.json, points.csv, the JSON
Schemas and data.zip. Fails, publishing nothing, unless \`mfm check-data\` passes.
Prints all of it; publishing is the workflow's \`gh release create\`.

  --assets <dir>       where the assets go: a new or empty directory
  --notes-file <file>  where the notes go
  --commit <sha>       the commit the release is for: the notes link to it, and GitHub
                       (GH_TOKEN, GITHUB_REPOSITORY) is asked whether the tag is
                       released already. Not yet: publish=true. At this commit (a
                       re-run): publish=false. At another commit: it fails, since that
                       commit changed data/ without a new changelog entry.
  --root <dir>         the repository (default: the one this command is in)
  --output <file>      append tag=…, title=… and, with --commit, publish=… to a
                       step-output file, such as $GITHUB_OUTPUT
`,
  options: {
    assets: { type: 'string' },
    'notes-file': { type: 'string' },
    commit: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
  },
  positionals: 0,
  async run(values, _, io) {
    const assetsDir = required(values, 'assets');
    const notesFile = required(values, 'notes-file');
    const commit = text(values, 'commit');
    if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) {
      throw new UsageError(`--commit must be a full commit SHA, got: ${commit}`);
    }
    const root = text(values, 'root') ?? REPO_ROOT;

    const problems = checkData(readGeneratedFiles(root));
    if (problems.length > 0) {
      for (const p of problems) io.err(`✗ ${p}\n\n`);
      io.err('mfm release: the generated files are not what the tools write (mfm check-data).\n');
      return 1;
    }

    const dataDir = join(root, 'data');
    const names = readdirSync(dataDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    const read = (name: string) => readFileSync(join(dataDir, name));
    const meta = metaFromYaml(read('meta.yaml').toString('utf8'));
    const factions = names
      .filter((name) => name.endsWith('.yaml') && name !== 'meta.yaml')
      .map((name) => factionFromYaml(read(name).toString('utf8')));
    const file = changelogFile(meta.version);
    if (!existsSync(join(root, file))) throw new Error(`${file} doesn't exist`);
    const release = buildRelease({
      meta,
      factions,
      files: names.map((name) => ({ name, data: read(name) })),
      changelog: readFileSync(join(root, file), 'utf8'),
      changelogUrl: `${REPO_URL}/blob/${commit ?? 'main'}/${file}`,
    });

    if (existsSync(assetsDir) && readdirSync(assetsDir).length > 0) {
      throw new Error(`--assets ${assetsDir} isn't empty: every file in it would be uploaded`);
    }
    mkdirSync(assetsDir, { recursive: true });
    for (const a of release.assets) writeFileSync(join(assetsDir, a.name), a.data);
    mkdirSync(dirname(notesFile), { recursive: true });
    writeFileSync(notesFile, release.notes);

    const width = Math.max(...release.assets.map((a) => a.name.length));
    const assets = release.assets.map((a) => {
      const sha = createHash('sha256').update(a.data).digest('hex');
      return `  ${a.name.padEnd(width)}  ${String(a.data.length).padStart(9)} bytes  sha256:${sha}`;
    });
    io.out(
      `Tag:   ${release.tag}\nTitle: ${release.title}\n\nAssets, in ${assetsDir}:\n${assets.join('\n')}\n\n` +
        `Notes, in ${notesFile}:\n\n${release.notes}\n`,
    );

    let publish: boolean | undefined;
    if (commit === undefined) {
      io.out('Not checked against GitHub: no --commit.\n');
    } else {
      const released = await releasedAt(githubFromEnv(), release.tag);
      publish = shouldPublish(release.tag, commit, released);
      io.out(
        publish
          ? `To publish: no release is tagged ${release.tag} yet.\n`
          : `Nothing to publish: ${release.tag} is released already, at this commit.\n`,
      );
    }
    const output = text(values, 'output');
    if (output) {
      writeOutputs(
        {
          tag: release.tag,
          title: release.title,
          ...(publish === undefined ? {} : { publish: String(publish) }),
        },
        output,
        io.out,
      );
    }
    return 0;
  },
};
