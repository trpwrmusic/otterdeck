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

/** Fingerprint of the server code: its newest change. Only this needs a restart. */
export function fingerprint(): string {
  let max = 0;
  for (const d of WATCHED) {
    try {
      max = Math.max(max, newest(d));
    } catch {}
  }
  return String(Math.round(max));
}

/** Fingerprint of the built UI. A new UI needs no restart: the files are read from disk on each load. */
function uiFingerprint(): string {
  try {
    return String(Math.round(fs.statSync(UI_ENTRY).mtimeMs));
  } catch {
    return '0';
  }
}

/** The server code this process runs. */
const SERVER_VERSION = fingerprint();
let ui = uiFingerprint();

/** Server code + UI; open windows reload when it changes (a new UI shows up right away). */
export const version = () => SERVER_VERSION + '-' + ui;

export const update = { available: false, pending: false };

export function watchForUpdates(onChange: () => void) {
  setInterval(() => {
    let changed = false;
    const nextUi = uiFingerprint();
    if (nextUi !== ui) {
      ui = nextUi;
      changed = true;
    }
    const now = fingerprint() !== SERVER_VERSION;
    if (now !== update.available) {
      update.available = now;
      changed = true;
    }
    if (changed) onChange();
  }, 2000).unref();
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
