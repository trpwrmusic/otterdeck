import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PORT = Number(process.env.OTTER_PORT || 4747);
export const HOST = '127.0.0.1';
export const DEV = process.env.OTTER_DEV === '1';
export const DEV_WEB_PORT = 5173;

export const ROOT = path.resolve(import.meta.dirname, '..');
export const WEB_DIST = path.join(ROOT, 'dist', 'web');
export const HOOK_SCRIPT = path.join(ROOT, 'hook', 'otter-hook.mjs');

export const DATA_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Otterdeck',
);
fs.mkdirSync(DATA_DIR, { recursive: true });

/** Shared secret for the hook endpoint. New on every start; only our own tabs know it. */
export const HOOK_TOKEN = crypto.randomBytes(24).toString('hex');

/** Files and pictures you add in the chat; every Claude tab may read this folder (--add-dir). */
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const HOME = os.homedir();
/** The Claude account used when a project has none of its own. */
export const DEFAULT_CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

function which(name: string): string | null {
  try {
    const out = execFileSync('where.exe', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

export const CLAUDE_BIN =
  process.env.OTTER_CLAUDE ||
  which('claude.exe') ||
  which('claude.cmd') ||
  path.join(HOME, '.local', 'bin', 'claude.exe');

export const SHELL_BIN = process.env.OTTER_SHELL || which('pwsh.exe') || 'powershell.exe';

export const NODE_BIN = process.execPath;

/** Forward slashes keep the path intact whether Claude runs hooks in Git Bash or cmd. */
export const slash = (p: string) => p.replace(/\\/g, '/');
