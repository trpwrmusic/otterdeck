// Notices when Otterdeck's own code changed on disk and restarts into the new version once no
// Claude is in the middle of a turn. Tabs resume their conversations in the new server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.ts';

const WATCHED = ['server', 'shared', 'hook'].map((d) => path.join(ROOT, d));
const UI_ENTRY = path.join(ROOT, 'dist', 'web', 'index.html');

function newest(dir: string): number {
  let max = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) max = Math.max(max, newest(p));
    else max = Math.max(max, fs.statSync(p).mtimeMs);
  }
  return max;
}

/** A fingerprint of the code: newest change in the server sources and the built UI. */
export function fingerprint(): string {
  let max = 0;
  for (const d of WATCHED) {
    try {
      max = Math.max(max, newest(d));
    } catch {}
  }
  try {
    max = Math.max(max, fs.statSync(UI_ENTRY).mtimeMs);
  } catch {}
  return String(Math.round(max));
}

/** What the running server was started with; the UI reloads when this changes. */
export const VERSION = fingerprint();

export const update = { available: false, pending: false };

export function watchForUpdates(onChange: () => void) {
  setInterval(() => {
    const now = fingerprint() !== VERSION;
    if (now !== update.available) {
      update.available = now;
      onChange();
    }
  }, 4000).unref();
}

/**
 * Starts a fresh copy of this server and exits. The new one waits for the port to become free
 * (see the listen retry in index.ts).
 */
export function respawn(beforeExit: () => void) {
  const log = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  const args = [...process.execArgv.filter((a) => a !== '--watch'), ...process.argv.slice(1)];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, OTTER_RESTARTED: '1' },
  });
  child.unref();
  beforeExit();
  process.exit(0);
}
