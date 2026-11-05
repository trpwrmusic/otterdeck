// Git for the changes panel: what changed, by how much, and the diff of one file.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile, Changes, CompareMode, DiffHunk, FileDiff } from '../shared/types.ts';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_TEXT = 1_000_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // --no-optional-locks: reading must not rewrite .git/index, or the file watcher would see a
      // change, reload the panel, run status again … forever.
      ['--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
    );
  });
}
const gitOk = (cwd: string, args: string[]) => git(cwd, args).then((s) => s.trim()).catch(() => null);

function isBinary(buf: Buffer) {
  return buf.subarray(0, 8000).includes(0);
}

function readText(file: string): { text: string | null; binary: boolean; tooLarge: boolean; size: number } {
  const size = fs.statSync(file).size;
  if (size > MAX_TEXT) return { text: null, binary: false, tooLarge: true, size };
  const buf = fs.readFileSync(file);
  if (isBinary(buf)) return { text: null, binary: true, tooLarge: false, size };
  return { text: buf.toString('utf8'), binary: false, tooLarge: false, size };
}

/** The branch "everything on this branch" is compared against: origin's default, else main/master. */
async function baseBranch(dir: string, current: string | null): Promise<string | null> {
  const originHead = await gitOk(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const candidates = [originHead, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === current) continue;
    if (await gitOk(dir, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`])) return c;
  }
  return null;
}

/** Which tree a mode compares the working tree against. */
async function compareRef(dir: string, mode: CompareMode, hasHead: boolean, base: string | null) {
  if (mode === 'base' && base && hasHead) {
    const mb = await gitOk(dir, ['merge-base', 'HEAD', base]);
    if (mb) return mb;
  }
  return hasHead ? 'HEAD' : EMPTY_TREE;
}

export async function changes(dir: string, mode: CompareMode): Promise<Changes> {
  const empty: Changes = {
    isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, base: null, mode, files: [], added: 0, removed: 0,
  };
  if (!fs.existsSync(dir)) return empty;
  let raw: string;
  try {
    raw = await git(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  } catch {
    return empty;
  }

  const res: Changes = { ...empty, isRepo: true };
  let hasHead = true;
  const status = new Map<string, ChangedFile>();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.oid')) hasHead = !line.endsWith('(initial)');
    else if (line.startsWith('# branch.head ')) res.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        res.ahead = Number(m[1]);
        res.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const f = line.split(' ');
      const xy = f[1];
      const p = line.startsWith('1 ') ? f.slice(8).join(' ') : line.startsWith('2 ') ? f.slice(9).join(' ') : f.slice(10).join(' ');
      const kind = xy.includes('A') ? 'added' : xy.includes('D') ? 'deleted' : line.startsWith('2 ') ? 'renamed' : line.startsWith('u ') ? 'conflict' : 'modified';
      const file: ChangedFile = { path: p, status: kind, added: 0, removed: 0, binary: false };
      if (line.startsWith('2 ')) file.oldPath = parts[++i];
      status.set(p, file);
    } else if (line.startsWith('? ')) {
      const p = line.slice(2);
      status.set(p, { path: p, status: 'untracked', added: 0, removed: 0, binary: false });
    }
  }

  res.base = await baseBranch(dir, res.branch);
  const ref = await compareRef(dir, mode, hasHead, res.base);

  // Everything tracked that differs from the reference tree (staged and unstaged together).
  const numstat = await git(dir, ['diff', '--numstat', '-z', '--no-renames', ref]).catch(() => '');
  const counts = new Map<string, { a: number; d: number; bin: boolean }>();
  for (const rec of numstat.split('\0')) {
    const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (m) counts.set(m[3], { a: m[1] === '-' ? 0 : Number(m[1]), d: m[2] === '-' ? 0 : Number(m[2]), bin: m[1] === '-' });
  }
  if (mode === 'base' && ref !== 'HEAD' && ref !== EMPTY_TREE) {
    // Files committed on this branch but clean in the working tree aren't in `status`.
    const names = await git(dir, ['diff', '--name-status', '-z', '--no-renames', ref]).catch(() => '');
    const ns = names.split('\0');
    for (let i = 0; i + 1 < ns.length; i += 2) {
      const [code, p] = [ns[i], ns[i + 1]];
      if (!p || status.has(p)) continue;
      status.set(p, { path: p, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', added: 0, removed: 0, binary: false });
    }
  }

  for (const f of status.values()) {
    const c = counts.get(f.path);
    if (c) {
      f.added = c.a;
      f.removed = c.d;
      f.binary = c.bin;
    } else if (f.status === 'untracked' || f.status === 'added') {
      try {
        const t = readText(path.join(dir, f.path));
        f.binary = t.binary;
        if (t.text !== null) f.added = t.text.length ? t.text.split('\n').length - (t.text.endsWith('\n') ? 1 : 0) : 0;
      } catch {}
    }
  }

  res.files = [...status.values()]
    .filter((f) => f.status !== 'modified' || f.added || f.removed || f.binary || counts.has(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  res.added = res.files.reduce((s, f) => s + f.added, 0);
  res.removed = res.files.reduce((s, f) => s + f.removed, 0);
  return res;
}

function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let o = 0;
  let n = 0;
  for (const line of patch.split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      cur = { oldStart: o, newStart: n, header: h[3].trim(), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const t = line[0];
    const text = line.slice(1).replace(/\r$/, '');
    if (t === '+') cur.lines.push({ t: '+', text, new: n++ });
    else if (t === '-') cur.lines.push({ t: '-', text, old: o++ });
    else if (t === ' ') cur.lines.push({ t: ' ', text, old: o++, new: n++ });
  }
  return hunks;
}

export async function fileDiff(dir: string, file: string, mode: CompareMode): Promise<FileDiff> {
  const abs = safeJoin(dir, file);
  const hasHead = !!(await gitOk(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']));
  const branch = await gitOk(dir, ['branch', '--show-current']);
  const ref = await compareRef(dir, mode, hasHead, await baseBranch(dir, branch));
  const tracked = !!(await gitOk(dir, ['ls-files', '--error-unmatch', '--', file]));
  const inRef = !!(await gitOk(dir, ['cat-file', '-e', `${ref}:${file}`]));

  if (!tracked && !inRef) {
    // New file git doesn't know yet: everything is an addition.
    if (!fs.existsSync(abs)) return { path: file, binary: false, tooLarge: false, hunks: [] };
    const t = readText(abs);
    if (t.text === null) return { path: file, binary: t.binary, tooLarge: t.tooLarge, hunks: [] };
    const lines = t.text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    return {
      path: file,
      binary: false,
      tooLarge: false,
      hunks: [{ oldStart: 0, newStart: 1, header: '', lines: lines.map((text, i) => ({ t: '+', text, new: i + 1 })) }],
    };
  }
  const patch = await git(dir, ['diff', '--no-ext-diff', '--no-renames', '-U4', ref, '--', file]).catch(() => '');
  if (/^Binary files /m.test(patch)) return { path: file, binary: true, tooLarge: false, hunks: [] };
  if (patch.length > 4 * MAX_TEXT) return { path: file, binary: false, tooLarge: true, hunks: [] };
  return { path: file, binary: false, tooLarge: false, hunks: parsePatch(patch) };
}

// ---------- files ----------

/** Resolves a path inside the project, refusing anything that points outside. */
export function safeJoin(root: string, rel: string) {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel || '.');
  if (abs !== base && !abs.toLowerCase().startsWith(base.toLowerCase() + path.sep)) throw new Error('Pfad außerhalb des Projekts.');
  return abs;
}

const HIDDEN = new Set(['.git']);
const QUIET = new Set(['node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo', '.cache', 'vendor', '__pycache__', '.venv', 'target', 'coverage']);

export function listDir(root: string, rel: string) {
  const abs = safeJoin(root, rel);
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => ({ name: e.name, dir: e.isDirectory(), quiet: QUIET.has(e.name) }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || Number(a.quiet) - Number(b.quiet) || a.name.localeCompare(b.name, 'de'));
}

export function readFile(root: string, rel: string) {
  const t = readText(safeJoin(root, rel));
  return { path: rel, ...t };
}
