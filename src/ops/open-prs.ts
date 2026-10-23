import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { UpdatePr } from '../stack.js';
import { gitEnv } from './git-env.js';
import { type GitHub, paginate } from './github.js';

/**
 * The open update PRs, and a copy of each one's `data/`. Update PRs are sticky: their
 * branches are force-pushed on every run while their version is live, and their `data/`
 * already carries the `firstSeen` stamps of the changes they captured. The scrape
 * matches against those copies as well as against `main` (`--dates-from`), so a run that
 * finds nothing new reproduces each branch byte for byte, and a later change widens an
 * update's dates instead of resetting them to today.
 */

/** The label every update PR carries. */
export const UPDATE_LABEL = 'mfm-update';

/** An open PR, as the REST API lists it: the fields the update stack is planned from. */
interface PullRequest {
  number: number;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string };
  labels: { name: string }[];
}

/**
 * The open update PRs, newest first: labelled `mfm-update`, from an `mfm/` branch of
 * this repository. Never a fork's, whose branch could carry anything.
 */
export async function listUpdatePrs(gh: GitHub): Promise<UpdatePr[]> {
  const prs = await paginate<PullRequest>(gh, '/pulls?state=open&per_page=100');
  return prs
    .filter(
      (p) =>
        p.labels.some((l) => l.name === UPDATE_LABEL) &&
        p.head.repo?.full_name.toLowerCase() === gh.repo.toLowerCase() &&
        p.head.ref.startsWith('mfm/'),
    )
    .map((p) => ({ number: p.number, headRefName: p.head.ref, baseRefName: p.base.ref }));
}

/** Run git in `cwd`, feeding it `input`; its stdout, or a throw with its stderr. */
function git(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((done, fail) => {
    const stdin = input === undefined ? 'ignore' : 'pipe';
    const child = spawn('git', args, { cwd, env: gitEnv(), stdio: [stdin, 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    child.on('error', fail);
    child.on('close', (code) => {
      if (code === 0) done(Buffer.concat(out));
      else fail(new Error(`git ${args.join(' ')}: ${Buffer.concat(err).toString().trim()}`));
    });
    // A git that exits before reading all of it closes the pipe: the write fails with
    // EPIPE, and the exit code above is what reports why.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/**
 * Fetch `branch` from `origin` and write the files under its `data/` into `dir`, without
 * the `data/` prefix. The checkout in `cwd` is left as it was: a shallow one (the
 * workflow's) fetches one commit deep, and a full clone stays full, since `--depth` would
 * make it shallow.
 */
export async function exportBranchData(branch: string, dir: string, cwd = '.'): Promise<void> {
  const ref = `refs/remotes/origin/${branch}`;
  const shallow = (await git(cwd, ['rev-parse', '--is-shallow-repository'])).toString().trim();
  const depth = shallow === 'true' ? ['--depth=1'] : [];
  await git(cwd, ['fetch', ...depth, 'origin', `+refs/heads/${branch}:${ref}`]);
  const blobs = (await git(cwd, ['ls-tree', '-r', '-z', '--full-tree', ref, '--', 'data/']))
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [info = '', path = ''] = line.split('\t');
      const [, type, sha] = info.split(' ');
      return { type, sha, path };
    })
    .filter((b) => b.type === 'blob');
  if (blobs.length === 0) throw new Error(`${branch} has no data/`);

  // One `cat-file --batch` for every file: "<sha> blob <size>\n<content>\n" each.
  const batch = await git(cwd, ['cat-file', '--batch'], blobs.map((b) => `${b.sha}\n`).join(''));
  let at = 0;
  for (const b of blobs) {
    const eol = batch.indexOf(0x0a, at);
    const [, type, length] = batch.subarray(at, eol).toString().split(' ');
    if (type !== 'blob') throw new Error(`git cat-file: no blob for ${b.path} on ${branch}`);
    const size = Number(length);
    const file = join(dir, b.path.slice('data/'.length));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, batch.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
}

/** Every open update PR, with the directory its `data/` was copied into: `<out>/<branch>`. */
export async function exportOpenPrs(
  gh: GitHub,
  out: string,
  cwd = '.',
): Promise<{ prs: UpdatePr[]; dirs: string[] }> {
  const prs = await listUpdatePrs(gh);
  const dirs: string[] = [];
  for (const pr of prs) {
    const dir = resolve(out, pr.headRefName);
    if (!dir.startsWith(resolve(out) + sep))
      throw new Error(`Unsafe branch name: ${pr.headRefName}`);
    await exportBranchData(pr.headRefName, dir, cwd);
    dirs.push(join(out, pr.headRefName));
  }
  return { prs, dirs };
}
