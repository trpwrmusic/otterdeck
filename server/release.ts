// Updates for an installed Otterdeck (install.ps1 / install.sh). The layout there:
//
//   <base>/versions/<version>/   one folder per version, complete with node_modules (this is ROOT)
//   <base>/current               name of the version that starts
//
// An update downloads the release package for this platform from GitHub, unpacks it next to the
// running version, points `current` at it and restarts once no Claude is working. The old folder
// stays until the one after, so a broken version can be undone by editing `current`.
// A git checkout (development) is not touched: there it is `git pull` as always.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT } from './config.ts';
import { settings } from './settings.ts';
import type { UpdateView } from '../shared/types.ts';

export const REPO = 'trpwrmusic/otterdeck';
export const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const parent = path.dirname(ROOT);
/** Installation folder, when this runs from <base>/versions/<version>. */
export const BASE = path.basename(parent) === 'versions' && fs.existsSync(path.join(path.dirname(parent), 'current')) ? path.dirname(parent) : null;
const INSTALL: UpdateView['install'] = BASE ? 'release' : fs.existsSync(path.join(ROOT, '.git')) ? 'git' : 'other';

/** Name of the package for this computer, e.g. otterdeck-win-x64.tar.gz */
export const ASSET = `otterdeck-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}.tar.gz`;

const st: UpdateView = { install: INSTALL, version: VERSION, latest: null, checkedAt: null, notes: null, busy: null, ready: null, error: null };
let download: string | null = null;
let onChange: () => void = () => {};

export const updateView = (): UpdateView => ({ ...st });

/** 1.10.0 > 1.9.2 */
export function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

function set(patch: Partial<UpdateView>) {
  Object.assign(st, patch);
  onChange();
}

export async function checkForUpdate(): Promise<UpdateView> {
  if (st.busy) return updateView();
  set({ busy: 'checking', error: null });
  try {
    // OTTER_RELEASE_API: another address with the same answer, for tests.
    const r = await fetch(process.env.OTTER_RELEASE_API || `https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'otterdeck' },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 404) throw new Error('Noch keine öffentliche Version gefunden.');
    if (!r.ok) throw new Error(`GitHub antwortet mit ${r.status}.`);
    const rel = await r.json();
    const latest = String(rel.tag_name ?? '').replace(/^v/, '');
    const asset = (rel.assets ?? []).find((a: any) => a.name === ASSET);
    download = asset?.browser_download_url ?? null;
    set({ latest, notes: String(rel.body ?? '').trim() || null, checkedAt: Date.now(), busy: null });
  } catch (err) {
    set({ busy: null, checkedAt: Date.now(), error: (err as Error).message });
  }
  return updateView();
}

/** There is a newer version this installation can install. */
export const updatable = () => INSTALL === 'release' && !!st.latest && newer(st.latest, st.ready ?? VERSION);

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<void>((resolve, reject) =>
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 10 * 60_000 }, (err, _o, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve())),
  );

/** Downloads and unpacks the newest version; it starts with the next restart. */
export async function installUpdate(): Promise<string> {
  if (!BASE) throw new Error('Diese Fassung ist nicht über den Installer eingerichtet. Aktualisieren mit git pull.');
  if (!st.latest || !newer(st.latest, VERSION)) await checkForUpdate();
  if (!st.latest || !newer(st.latest, VERSION)) throw new Error('Otterdeck ist auf dem neuesten Stand.');
  if (!download) throw new Error(`Für dieses System (${ASSET}) gibt es in Version ${st.latest} kein Paket.`);
  const version = st.latest;
  const versions = path.join(BASE, 'versions');
  const target = path.join(versions, version);
  const part = target + '.part';
  const file = path.join(versions, `${version}.tar.gz`);
  try {
    set({ busy: 'downloading', error: null });
    const r = await fetch(download, { headers: { 'user-agent': 'otterdeck' }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen (${r.status}).`);
    await pipeline(Readable.fromWeb(r.body as any), fs.createWriteStream(file));

    set({ busy: 'installing' });
    fs.rmSync(part, { recursive: true, force: true });
    fs.mkdirSync(part, { recursive: true });
    // Windows 10 and newer bring tar along.
    await run(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xzf', file, '-C', part]);
    if (!fs.existsSync(path.join(part, 'server', 'index.ts'))) throw new Error('Das Paket ist unvollständig.');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(part, target);
    const cur = path.join(BASE, 'current');
    fs.writeFileSync(cur + '.tmp', version);
    fs.renameSync(cur + '.tmp', cur);
    prune(versions, [version, VERSION]);
    set({ busy: null, ready: version });
    return version;
  } catch (err) {
    fs.rmSync(part, { recursive: true, force: true });
    set({ busy: null, error: (err as Error).message });
    throw err;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Keeps the running and the new version, removes older ones. */
function prune(versions: string, keep: string[]) {
  for (const e of fs.readdirSync(versions, { withFileTypes: true })) {
    if (!e.isDirectory() || keep.includes(e.name)) continue;
    try {
      fs.rmSync(path.join(versions, e.name), { recursive: true, force: true });
    } catch {} // still in use (Windows): next time
  }
}

/** Folder the next start runs from: the installed new version, else this one. */
export function nextRoot(): string {
  if (!BASE) return ROOT;
  try {
    const cur = fs.readFileSync(path.join(BASE, 'current'), 'utf8').trim();
    const dir = path.join(BASE, 'versions', cur);
    if (cur && fs.existsSync(path.join(dir, 'server', 'index.ts'))) return dir;
  } catch {}
  return ROOT;
}

export function watchReleases(changed: () => void) {
  onChange = changed;
  if (INSTALL !== 'release') return;
  const tick = () => settings().updateCheck && checkForUpdate();
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 6 * 3600_000).unref();
}
