import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * The drift fixer's patch, checked and applied before the App's token goes anywhere near
 * it, and the draft PR's body. `drift-fix.yml`'s `pr` job runs this file, and that job
 * holds the App's key, so it is the one repository file there: it imports Node's own
 * modules and nothing else, not even the rest of `src/`, and runs under plain Node
 * (`node --experimental-strip-types`) with no node_modules. A test holds it to that. See
 * "The drift fixer" in specs/change-tracking.md.
 *
 * The patch comes from the agent's job, where a model read pages of the live site and
 * ran code, so everything about it is untrusted. It is read strictly: every line must be
 * where `git diff` puts it, so this reading and `git apply`'s can't disagree about which
 * files it touches, and anything else is rejected rather than skipped. Then the tree it
 * leaves is checked against the same list.
 */

/** Where the agent may change files: the parser, its spec, its tests, and the decisions. */
export const ALLOWED_DIRS = ['src/', 'specs/', 'test/', 'docs/decisions/'] as const;
/** Saved pages are downloads, never edits: a maintainer commits the refreshed one. */
export const FORBIDDEN_DIRS = ['test/fixtures/'] as const;
/** Far more than a selector fix needs, and little enough to read. */
export const MAX_PATCH_BYTES = 512 * 1024;
export const MAX_FILES = 40;
/** The longest note from the agent the PR body quotes. */
export const MAX_NOTES = 20_000;

export class PatchRejected extends Error {}

export interface PatchFile {
  path: string;
  change: 'add' | 'modify' | 'delete' | 'rename';
  /** A rename's old path. */
  from?: string;
}

/**
 * A path made of plain names: letters, digits, `.`, `_` and `-`, no segment starting with a
 * dot (so no `..`, `.git` or `.github`), no quoting, spaces or glob characters.
 */
const PLAIN_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** Why the agent may not change `path`, or undefined when it may. */
export function disallowed(path: string): string | undefined {
  if (path.length > 200 || !PLAIN_PATH.test(path))
    return `not a plain path: ${JSON.stringify(path)}`;
  if (FORBIDDEN_DIRS.some((dir) => path.startsWith(dir))) return `${path} is a saved page`;
  if (!ALLOWED_DIRS.some((dir) => path.startsWith(dir))) {
    return `${path} is outside ${ALLOWED_DIRS.join(', ')}`;
  }
  return undefined;
}

/**
 * Credentials the agent's job could have seen: the model's key, a GitHub token, a private
 * key. A patch or a note carrying one is an attempt to publish it.
 */
const CREDENTIAL =
  /sk-ant-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export const looksLikeCredential = (text: string): boolean => CREDENTIAL.test(text);

const DIFF_HEADER = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/;
const INDEX = /^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: 100644)?$/;

/** What a patch does to one file's text: the lines it adds, and how many it removes. */
export interface PatchLines {
  added: string[];
  removed: number;
}

/**
 * Read a patch as `git diff` writes it and list the files it changes, or throw
 * `PatchRejected`. Only regular files (mode 100644), changed in place, added, deleted or
 * renamed, all under `ALLOWED_DIRS`; no binary changes, mode changes, links, submodules or
 * copies, and nothing that looks like a credential.
 */
export function checkPatch(text: string): PatchFile[] {
  return readPatch(text).files;
}

/** `checkPatch`, with each file's added lines and removed-line count, by its path. */
export function readPatch(text: string): { files: PatchFile[]; lines: Map<string, PatchLines> } {
  const reject = (why: string): never => {
    throw new PatchRejected(why);
  };
  if (Buffer.byteLength(text) > MAX_PATCH_BYTES)
    reject(`the patch is over ${MAX_PATCH_BYTES} bytes`);
  const changes = new Map<string, PatchLines>();
  if (text === '') return { files: [], lines: changes };
  if (!text.endsWith('\n')) reject('the patch does not end with a line break');
  const lines = text.slice(0, -1).split('\n');
  const at = (i: number) => `line ${i + 1}`;
  const files: PatchFile[] = [];
  const seen = new Set<string>();
  const claim = (path: string, i: number) => {
    const why = disallowed(path);
    if (why) reject(`${at(i)}: ${why}`);
    if (seen.has(path)) reject(`${at(i)}: ${path} appears twice`);
    seen.add(path);
  };

  let i = 0;
  while (i < lines.length) {
    const header = DIFF_HEADER.exec(lines[i] ?? '');
    if (!header) reject(`${at(i)}: expected a "diff --git" line`);
    const start = i;
    const [, a = '', b = ''] = header ?? [];
    i++;

    let added = false;
    let deleted = false;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    for (; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.startsWith('--- ') || DIFF_HEADER.test(line)) break;
      if (INDEX.test(line) || /^similarity index \d{1,3}%$/.test(line)) continue;
      if (line === 'new file mode 100644') added = true;
      else if (line === 'deleted file mode 100644') deleted = true;
      else if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length);
      else reject(`${at(i)}: not a change to a regular file's text: ${JSON.stringify(line)}`);
    }

    const renamed = renameFrom !== undefined || renameTo !== undefined;
    if (renamed && (renameFrom !== a || renameTo !== b || a === b || added || deleted)) {
      reject(`${at(start)}: a rename that doesn't match its header`);
    }
    if (!renamed && a !== b) reject(`${at(start)}: two paths, but no rename`);
    if (added && deleted) reject(`${at(start)}: added and deleted at once`);
    if (renamed) claim(a, start);
    claim(b, start);

    const change: PatchLines = { added: [], removed: 0 };
    changes.set(b, change);
    const line = lines[i];
    if (line?.startsWith('--- ')) {
      const old = added ? '/dev/null' : `a/${a}`;
      const next = deleted ? '/dev/null' : `b/${b}`;
      if (line !== `--- ${old}`) reject(`${at(i)}: expected "--- ${old}"`);
      i++;
      if (lines[i] !== `+++ ${next}`) reject(`${at(i)}: expected "+++ ${next}"`);
      i++;
      let hunks = 0;
      while (i < lines.length && lines[i]?.startsWith('@@ ')) {
        const hunk = HUNK_HEADER.exec(lines[i] ?? '');
        if (!hunk) reject(`${at(i)}: not a hunk header`);
        let oldLeft = Number(hunk?.[1] ?? 1);
        let newLeft = Number(hunk?.[2] ?? 1);
        hunks++;
        i++;
        while (oldLeft > 0 || newLeft > 0 || lines[i]?.startsWith('\\ ')) {
          const content = lines[i];
          if (content === undefined) reject(`${at(i)}: the hunk ends early`);
          const kind = content?.[0];
          if (kind === ' ') {
            oldLeft--;
            newLeft--;
          } else if (kind === '-') {
            oldLeft--;
            change.removed++;
          } else if (kind === '+') {
            newLeft--;
            if (looksLikeCredential(content ?? '')) {
              reject(`${at(i)}: it adds something that looks like a credential`);
            }
            change.added.push((content ?? '').slice(1));
          } else if (!content?.startsWith('\\ ')) {
            reject(`${at(i)}: not a line of the hunk`);
          }
          if (oldLeft < 0 || newLeft < 0) reject(`${at(i)}: more lines than the hunk header says`);
          i++;
        }
      }
      if (hunks === 0) reject(`${at(i)}: a file header with no hunks`);
    } else if (!added && !deleted && !renamed) {
      // Only an empty file added or deleted, or a pure rename, has no hunks.
      reject(`${at(start)}: a change with no content`);
    }

    files.push({
      path: b,
      change: renamed ? 'rename' : added ? 'add' : deleted ? 'delete' : 'modify',
      ...(renamed ? { from: a } : {}),
    });
    if (files.length > MAX_FILES) reject(`more than ${MAX_FILES} files`);
  }
  return { files, lines: changes };
}

/**
 * What a low-risk fix may change (0040): the parser, the strings it accepts, the list of
 * saved pages, the parser's tests, and the scraping spec; a new decision record too. Not a
 * snapshot: vitest loads a snapshot file with `new Function`, so it is code no word list
 * vets.
 */
export const LOW_RISK_FILES: readonly RegExp[] = [
  /^src\/parse\/[A-Za-z0-9_-]+\.ts$/,
  /^src\/allowlists\.ts$/,
  /^src\/fixtures\.ts$/,
  /^specs\/scraping\.md$/,
  /^test\/parse\.test\.ts$/,
];
/** The most lines a low-risk fix adds and removes together. */
export const MAX_LOW_RISK_LINES = 150;
/** How the agent's note hands its fix to a person: its first line starts with this. */
export const NEEDS_REVIEW = 'Needs review:';
/**
 * An added line that imports, re-exports, or names a way out of the parser: to the
 * process, the globals, other modules, the network or Node's own modules. `import` counts
 * anywhere on a line but in `import.meta`, and so does `from '…'`, the last line of an
 * import or export over several. A screen for the plain route, not a sandbox: JavaScript
 * reaches `process` by routes no word list catches.
 */
export const REACH =
  /\b(?:process|globalThis|global|require|eval|Function|constructor|prototype|__proto__|Reflect|Proxy|fetch|WebAssembly|child_process)\b|^\s*export\b[^;]*\bfrom\b|\bimport\b(?:\s*\()?(?!\s*\.\s*meta\b)|\bfrom\s*['"]|['"`]node:/;

/**
 * What a `REACH` match names, in fixed words: the reasons go into the PR and the failure
 * issue, and an `export … from` match holds whatever the model wrote between the two.
 */
function word(match: string): string {
  const text = match.trim();
  if (text.startsWith('export')) return 'export … from';
  if (text.startsWith('from')) return 'from';
  if (text.startsWith('import')) return text.endsWith('(') ? 'dynamic import' : 'import';
  if (text.endsWith('node:')) return 'node:';
  return text;
}

export interface RiskInput {
  files: PatchFile[];
  lines: Map<string, PatchLines>;
  meta: RunMeta;
  /** The agent's note. */
  notes: string;
  /** The scrape's pages the PR adds as fixtures. */
  pages: string[];
  /** The scrape's pages whose names were free under `test/fixtures/`. */
  freePages: string[];
}

export interface Risk {
  low: boolean;
  /** Each rule the fix fails, for the PR and the failure issue; empty when it is low. */
  reasons: string[];
}

/** Whether a fix merges itself, by the rules of 0040 that code can check, never a model. */
export function assessRisk({ files, lines, meta, notes, pages, freePages }: RiskInput): Risk {
  const reasons: string[] = [];
  if (!meta.finished) reasons.push('the agent did not finish');
  if (cleanNotes(notes).startsWith(NEEDS_REVIEW)) reasons.push('the agent asked for review');
  const lowRisk = (path: string, change: PatchFile['change']) =>
    LOW_RISK_FILES.some((re) => re.test(path)) ||
    (change === 'add' && /^docs\/decisions\/[A-Za-z0-9_-]+\.md$/.test(path));
  for (const f of files) {
    for (const path of f.from ? [f.from, f.path] : [f.path]) {
      if (!lowRisk(path, f.change)) {
        reasons.push(`${path} is outside the parser, its tests and the scraping spec`);
      }
    }
  }
  if (!files.some((f) => f.path.startsWith('src/'))) reasons.push('it changes nothing under src/');
  let changed = 0;
  for (const f of files) {
    const { added = [], removed = 0 } = lines.get(f.path) ?? {};
    changed += added.length + removed;
    if (!/^(?:src|test)\//.test(f.path)) continue;
    const reach = added.map((line) => REACH.exec(line)?.[0]).find((m) => m !== undefined);
    if (reach !== undefined) reasons.push(`${f.path} adds a line that reaches out: ${word(reach)}`);
  }
  if (changed > MAX_LOW_RISK_LINES) {
    reasons.push(`it changes ${changed} lines, over ${MAX_LOW_RISK_LINES}`);
  }
  if (freePages.length === 0) {
    reasons.push('every page that shows the drift already has a fixture under its name');
  } else if (pages.length === 0) reasons.push('its tests read no page from the scrape');
  return { low: reasons.length === 0, reasons };
}

/** The paths `git status --porcelain=v1 -z --no-renames` lists. */
export function statusPaths(status: string): string[] {
  return status
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => entry.slice(3));
}

function git(dir: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout;
}

/**
 * Check the patch, apply it to the checkout in `dir` (`git apply`, which refuses paths
 * outside the tree and through links on its own), and check that the tree changed exactly
 * where the patch said, as regular files. Returns the files.
 */
export function applyPatch(dir: string, patchPath: string): PatchFile[] {
  const files = checkPatch(readFileSync(patchPath, 'utf8'));
  if (files.length === 0) return files;
  git(dir, 'apply', '--whitespace=nowarn', resolve(patchPath));
  const changed = new Set(
    statusPaths(
      git(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'),
    ),
  );
  const expected = new Set(files.flatMap((f) => (f.from ? [f.from, f.path] : [f.path])));
  for (const path of changed) {
    if (!expected.has(path)) throw new PatchRejected(`the patch changed ${path} too`);
  }
  for (const path of expected) {
    if (!changed.has(path)) throw new PatchRejected(`the patch left ${path} as it was`);
    const full = join(dir, path);
    if (existsSync(full) && !lstatSync(full).isFile()) {
      throw new PatchRejected(`${path} is not a regular file`);
    }
  }
  return files;
}

/** A saved page's name, as `src/fixtures.ts` names one: a faction slug and `.html`. */
const PAGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const fixturePath = (checkout: string, name: string) => join(checkout, 'test', 'fixtures', name);
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/**
 * The pages of the scrape's `drift` artifact (`driftDir`) a fix may add: regular files
 * with a page's name, not links, whose name no fixture in `checkout` has. The fixtures
 * there pin older pages on purpose, so a refreshed one never takes their place (0029).
 */
export function freePages(driftDir: string, checkout: string): string[] {
  if (!existsSync(driftDir)) return [];
  return readdirSync(driftDir)
    .filter((name) => PAGE_NAME.test(name))
    .filter((name) => lstatSync(join(driftDir, name)).isFile())
    .filter((name) => !exists(fixturePath(checkout, name)))
    .sort();
}

/**
 * Of `names`, the pages the patch's tests read: a line it adds under `test/` holds the
 * name as a string, as `fixture('orks-legends-cookie.html')` does. A name in a comment
 * doesn't count: #114's test named the page it copied markup from, and read another.
 */
export function pagesNamed(names: string[], lines: Map<string, PatchLines>): string[] {
  const tests = [...lines]
    .filter(([path]) => path.startsWith('test/'))
    .flatMap(([, { added }]) => added);
  return names.filter((name) => {
    const read = new RegExp(`(['"\`])${name.replaceAll('.', '\\.')}\\1`);
    return tests.some((line) => read.test(line));
  });
}

/**
 * Copy `names` from the drift artifact into `checkout`'s `test/fixtures/`, byte for byte:
 * the scrape saved them, so no fixture in the PR comes from the model. Never over a fixture.
 */
export function addPages(driftDir: string, checkout: string, names: string[]): void {
  for (const name of names) {
    if (!PAGE_NAME.test(name))
      throw new PatchRejected(`not a page's name: ${JSON.stringify(name)}`);
    const to = fixturePath(checkout, name);
    if (exists(to)) throw new PatchRejected(`test/fixtures/${name} is already a fixture`);
    copyFileSync(join(driftDir, name), to, constants.COPYFILE_EXCL);
  }
}

/** What the agent's job reports about its run. */
export interface RunMeta {
  turns?: number;
  costUsd?: number;
  /** False when the agent stopped short, at its turn or budget limit (drift-fix.yml fails any other run). */
  finished: boolean;
}

/**
 * The run's turns, cost and whether the agent finished, from the agent job's JSON; a number
 * that isn't plausible is left out, and anything short of `finished: true` is unfinished.
 */
export function readMeta(json: string): RunMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { finished: false };
  }
  const field = (key: string) => (raw as Record<string, unknown> | null)?.[key];
  const value = (key: string, max: number) => {
    const v = field(key);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
  };
  const turns = value('turns', 10_000);
  const costUsd = value('cost', 1_000);
  return {
    ...(turns === undefined ? {} : { turns: Math.round(turns) }),
    ...(costUsd === undefined ? {} : { costUsd }),
    finished: field('finished') === true,
  };
}

/** The agent's note, as plain text a PR body can quote: no control characters, cut to `MAX_NOTES`. */
export function cleanNotes(notes: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  const plain = notes.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return plain.length > MAX_NOTES ? `${plain.slice(0, MAX_NOTES)}\n[… cut]` : plain;
}

/** A code fence longer than any run of backticks in `text`, so the text can't close it. */
export function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export interface BodyInput {
  files: PatchFile[];
  /** The agent's note, quoted as plain text. */
  notes: string;
  meta: RunMeta;
  scrapeRunUrl: string;
  agentRunUrl: string;
  issue?: number;
  /** The scrape's pages the PR adds as fixtures. */
  pages: string[];
  risk: Risk;
}

/** GitHub's limit on a PR body, in characters. */
export const BODY_LIMIT = 65_536;

/**
 * The draft PR's body. Everything the agent wrote is in a code block, where nothing in it
 * renders. Under `BODY_LIMIT` whatever the note holds: the file list is bounded by
 * `MAX_FILES` and the paths' length, and the note (with its fence, which a run of
 * backticks lengthens) is cut until the body fits.
 */
export function prBody(input: BodyInput): string {
  let text = cleanNotes(input.notes) || '(no note)';
  let body = renderBody(input, text);
  while (body.length > BODY_LIMIT && text.length > 100) {
    text = `${text.slice(0, Math.floor(text.length / 2))}\n[… cut]`;
    body = renderBody(input, text);
  }
  if (body.length > BODY_LIMIT) throw new PatchRejected('the PR body is over GitHub’s limit');
  return body;
}

function renderBody(
  { files, meta, scrapeRunUrl, agentRunUrl, issue, pages, risk }: BodyInput,
  text: string,
): string {
  const describe = (f: PatchFile) =>
    f.change === 'rename'
      ? `\`${f.from}\` → \`${f.path}\` (renamed)`
      : `\`${f.path}\` (${f.change === 'add' ? 'added' : f.change === 'delete' ? 'deleted' : 'changed'})`;
  const tick = fence(text);
  const run = [
    `Agent run: ${agentRunUrl}`,
    meta.turns === undefined ? undefined : `${meta.turns} turns`,
    meta.costUsd === undefined ? undefined : `$${meta.costUsd.toFixed(2)}`,
  ].filter((part) => part !== undefined);
  return [
    `Drafted by the drift-fix agent after a scrape failed: ${scrapeRunUrl}.${issue === undefined ? '' : ` Refs #${issue}.`}`,
    '',
    '> [!CAUTION]',
    ...(risk.low
      ? [
          '> A model wrote this from pages of the live site, which are untrusted input. It passes the rules that code checks (docs/decisions/0040), so it merges itself once CI and the live smoke test pass, without review: read it afterwards.',
        ]
      : [
          '> A model wrote this from pages of the live site, which are untrusted input. It stays a draft until a maintainer has read every line, because:',
          ...risk.reasons.map((reason) => `> - ${reason}`),
        ]),
    ...(meta.finished
      ? []
      : [
          '>',
          '> **The agent did not finish** (it reached its turn or budget limit): this is the work it had done when it stopped.',
        ]),
    '',
    '### Files',
    ...files.map((f) => `- ${describe(f)}`),
    ...pages.map((page) => `- \`test/fixtures/${page}\` (added from the scrape)`),
    '',
    "### The agent's note",
    `${tick}text`,
    text,
    tick,
    '',
    ...(risk.low
      ? [
          '### After it merges',
          "- [ ] Read it. What it changes in the data is in the live smoke test's job summary, among this PR's checks, and reaches `data/` only through the next update PR.",
        ]
      : [
          '### Before it is ready',
          '- [ ] Read every changed line, snapshots included, against the refreshed page the note names.',
          ...(pages.length > 0
            ? []
            : [
                "- [ ] Commit that page as the fixture, with an assertion that covers the drift: the agent can't download pages or change `test/fixtures/`. The refreshed pages are in the scrape run's `drift` artifact, or run `pnpm refresh-fixtures --only <name>`.",
              ]),
          '- [ ] `pnpm verify`.',
        ]),
    '',
    `<sub>${run.join(' · ')}</sub>`,
    '',
  ].join('\n');
}

const USAGE = `usage: node --experimental-strip-types src/ops/agent-patch.ts <checkout> <patch>
         --scrape-run <id> [--issue <n>] [--notes <file>] [--meta <file>]
         [--drift <dir>] --body-file <file> [--output <file>]

Checks the drift fixer's patch, applies it to <checkout>, adds the pages of the scrape's
drift artifact (--drift, its fixtures directory) that the patch's tests read, decides the
fix's risk (docs/decisions/0040), and writes the PR's body. Step outputs: changed=true or
false; paths=<the files, comma-separated>, for create-pull-request's add-paths;
risk=low or high; reasons=<the rules a high-risk fix fails, "; "-separated>. Exits 1, with
the reason, on a patch it rejects. Reads GITHUB_SERVER_URL, GITHUB_REPOSITORY and
GITHUB_RUN_ID for the links.
`;

/** Where the command line writes: its result to `out`, notes and errors to `err`. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const stdio: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Run the check from the command line; returns the exit code. */
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = stdio): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'scrape-run': { type: 'string' },
      issue: { type: 'string' },
      notes: { type: 'string' },
      meta: { type: 'string' },
      drift: { type: 'string' },
      'body-file': { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const [dir, patch] = positionals;
  const scrapeRun = values['scrape-run'] ?? '';
  const bodyFile = values['body-file'];
  const issue = values.issue ?? '';
  if (positionals.length !== 2 || !dir || !patch || !bodyFile || !/^\d+$/.test(scrapeRun)) {
    io.err(USAGE);
    return 2;
  }
  if (issue !== '' && !/^\d+$/.test(issue)) {
    io.err(`Not an issue number: ${issue}\n`);
    return 2;
  }
  const {
    GITHUB_SERVER_URL = 'https://github.com',
    GITHUB_REPOSITORY = '',
    GITHUB_RUN_ID = '',
  } = env;
  const repoUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`;
  const read = (file: string | undefined) =>
    file && existsSync(file) ? readFileSync(file, 'utf8') : '';

  let files: PatchFile[];
  let pages: string[] = [];
  let risk: Risk;
  try {
    const notes = read(values.notes);
    if (looksLikeCredential(notes))
      throw new PatchRejected("the agent's note looks like it holds a credential");
    files = applyPatch(dir, patch);
    const { lines } = readPatch(readFileSync(patch, 'utf8'));
    const meta = readMeta(read(values.meta));
    const free = values.drift ? freePages(values.drift, dir) : [];
    if (values.drift && files.length > 0) {
      pages = pagesNamed(free, lines);
      addPages(values.drift, dir, pages);
    }
    risk = assessRisk({ files, lines, meta, notes, pages, freePages: free });
    writeFileSync(
      bodyFile,
      prBody({
        files,
        notes,
        meta,
        scrapeRunUrl: `${repoUrl}/actions/runs/${scrapeRun}`,
        agentRunUrl: `${repoUrl}/actions/runs/${GITHUB_RUN_ID}`,
        ...(issue === '' ? {} : { issue: Number(issue) }),
        pages,
        risk,
      }),
    );
  } catch (err) {
    if (!(err instanceof PatchRejected)) throw err;
    io.err(`::error title=Patch rejected::${err.message}\n`);
    return 1;
  }
  const paths = [
    ...files.flatMap((f) => (f.from ? [f.from, f.path] : [f.path])),
    ...pages.map((page) => `test/fixtures/${page}`),
  ];
  const outputs = `changed=${files.length > 0}\npaths=${paths.join(',')}\nrisk=${risk.low ? 'low' : 'high'}\nreasons=${risk.reasons.join('; ')}\n`;
  if (values.output) appendFileSync(values.output, outputs);
  else io.out(outputs);
  io.err(
    files.length === 0
      ? 'The agent changed nothing.\n'
      : `The patch changes ${files.length} file${files.length === 1 ? '' : 's'}, all where the agent may.\n`,
  );
  return 0;
}

// Run when executed, not when imported (the tests import it). Compared by real path, so a
// symlinked checkout still runs.
const entry = process.argv[1];
if (
  entry &&
  existsSync(entry) &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2));
}
