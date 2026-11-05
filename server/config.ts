import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
/** Otterdeck on a server (Linux, no window): reached only over Tailscale, Claude logs in with a long-lived token. */
export const SERVER_MODE = process.env.OTTER_SERVER === '1';

export const PORT = Number(process.env.OTTER_PORT || 4747);
export const HOST = '127.0.0.1';
export const DEV = process.env.OTTER_DEV === '1';
export const DEV_WEB_PORT = 5173;

export const ROOT = path.resolve(import.meta.dirname, '..');
export const WEB_DIST = path.join(ROOT, 'dist', 'web');
export const HOOK_SCRIPT = path.join(ROOT, 'hook', 'otter-hook.mjs');
export const STATUS_SCRIPT = path.join(ROOT, 'hook', 'otter-status.mjs');

export const DATA_DIR = process.env.OTTER_DATA
  ? path.resolve(process.env.OTTER_DATA)
  : IS_WIN
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Otterdeck')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'otterdeck');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** Shared secret for the hook endpoint. New on every start; only our own tabs know it. */
export const HOOK_TOKEN = crypto.randomBytes(24).toString('hex');

/** Files and pictures you add in the chat; every Claude tab may read this folder (--add-dir). */
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
/** Icons picked for projects and groups (file name stored in state.json). */
export const ICON_DIR = path.join(DATA_DIR, 'icons');
fs.mkdirSync(ICON_DIR, { recursive: true });

export const HOME = os.homedir();
/** The Claude account used when a project has none of its own. */
export const DEFAULT_CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

function which(name: string): string | null {
  try {
    const out = execFileSync(IS_WIN ? 'where.exe' : 'which', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

export const CLAUDE_BIN = IS_WIN
  ? process.env.OTTER_CLAUDE || which('claude.exe') || which('claude.cmd') || path.join(HOME, '.local', 'bin', 'claude.exe')
  : process.env.OTTER_CLAUDE || which('claude') || path.join(HOME, '.local', 'bin', 'claude');

export const SHELL_BIN = IS_WIN
  ? process.env.OTTER_SHELL || which('pwsh.exe') || 'powershell.exe'
  : process.env.OTTER_SHELL || process.env.SHELL || '/bin/bash';

/** Server mode: the long-lived Claude token (claude setup-token), readable only by this user. */
export const CLAUDE_TOKEN_FILE = path.join(DATA_DIR, 'claude-token');

export const NODE_BIN = process.execPath;

/** Forward slashes keep the path intact whether Claude runs hooks in Git Bash or cmd. */
export const slash = (p: string) => p.replace(/\\/g, '/');
