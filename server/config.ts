import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings } from './settings.ts';

export const IS_WIN = process.platform === 'win32';
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

/** As Otterdeck started: settings.json, environment variables on top (see settings.ts). */
export const SETTINGS = loadSettings(DATA_DIR);
/** Otterdeck on a server (no window): reached only over Tailscale, Claude logs in with a long-lived token. */
export const SERVER_MODE = SETTINGS.role === 'server';
export const PORT = SETTINGS.port || 4747;

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

export function which(name: string): string | null {
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

/** Where Claude Code is found without a path in the settings (looked up again once it is gone or new). */
export const findClaude = () =>
  IS_WIN
  ? which('claude.exe') || which('claude.cmd') || path.join(HOME, '.local', 'bin', 'claude.exe')
  : which('claude') || path.join(HOME, '.local', 'bin', 'claude');
let found = findClaude();
/** The Claude Code program tabs start. Installed while Otterdeck runs: found on the next tab. */
export function claudeBin(): string {
  if (SETTINGS.claudeBin) return SETTINGS.claudeBin;
  if (!fs.existsSync(found)) found = findClaude();
  return found;
}

export const FOUND_SHELL = IS_WIN ? which('pwsh.exe') || 'powershell.exe' : process.env.SHELL || '/bin/bash';
export const SHELL_BIN = SETTINGS.shellBin || FOUND_SHELL;

/** Server mode: the long-lived Claude token (claude setup-token), readable only by this user. */
export const CLAUDE_TOKEN_FILE = path.join(DATA_DIR, 'claude-token');

export const NODE_BIN = process.execPath;

/** Forward slashes keep the path intact whether Claude runs hooks in Git Bash or cmd. */
export const slash = (p: string) => p.replace(/\\/g, '/');
