import { spawn } from 'node:child_process';
import { gitEnv } from './git-env.js';

/** Run git in `cwd`, feeding it `input`; its stdout, or a throw with its stderr. */
export function git(cwd: string, args: string[], input?: string): Promise<Buffer> {
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
 * The files directly under `dir/` at `commit`, as git has them: names without the `dir/`
 * prefix, and their bytes. Read with one `ls-tree` and one `cat-file --batch`, so a whole
 * snapshot costs two processes. Throws when the commit isn't there (a shallow clone).
 */
export async function filesAt(
  cwd: string,
  commit: string,
  dir: string,
): Promise<{ name: string; data: Buffer }[]> {
  const listing = (await git(cwd, ['ls-tree', '-z', commit, '--', `${dir}/`])).toString('utf8');
  const blobs = listing
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const [, type, sha] = entry.slice(0, tab).split(' ');
      return { type, sha: sha ?? '', name: entry.slice(tab + 1).slice(dir.length + 1) };
    })
    .filter((b) => b.type === 'blob');
  if (blobs.length === 0) return [];
  const batch = await git(cwd, ['cat-file', '--batch'], `${blobs.map((b) => b.sha).join('\n')}\n`);
  const files: { name: string; data: Buffer }[] = [];
  let at = 0;
  for (const b of blobs) {
    const eol = batch.indexOf(0x0a, at);
    const [sha, , size] = batch.subarray(at, eol).toString('utf8').split(' ');
    if (sha !== b.sha) throw new Error(`git cat-file: expected ${b.sha}, got ${sha}`);
    const start = eol + 1;
    const end = start + Number(size);
    files.push({ name: b.name, data: batch.subarray(start, end) });
    at = end + 1; // the newline after each object
  }
  return files;
}
