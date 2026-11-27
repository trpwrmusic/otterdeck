// Otterdeck's settings, stored in <data>/settings.json and edited on the settings page.
// An environment variable still wins over the file (the old way, and handy for tests and systemd);
// the settings page then shows the field as fixed.
import fs from 'node:fs';
import path from 'node:path';
import type { Settings, SettingsKey } from '../shared/types.ts';

export const DEFAULTS: Settings = {
  setupDone: false,
  role: 'desktop',
  port: 4747,
  openWindow: true,
  autostart: false,
  servePort: 0,
  tailscaleCli: '',
  tailscaleSocket: '',
  tailnetProxy: '',
  claudeBin: '',
  claudeArgs: '',
  shellBin: '',
  agyBin: '',
  sharedMemory: false,
  taskDir: '',
  nolaEnabled: true,
  nolaHelper: '',
  nolaProjectsBoard: 5,
  nolaTodoBoards: '6,2',
  updateCheck: true,
};

/** Which environment variable fixes which setting. */
export const ENV: Partial<Record<SettingsKey, string>> = {
  role: 'OTTER_SERVER',
  port: 'OTTER_PORT',
  openWindow: 'OTTER_NO_WINDOW',
  servePort: 'OTTER_SERVE_PORT',
  tailscaleCli: 'OTTER_TAILSCALE',
  tailscaleSocket: 'OTTER_TAILSCALE_SOCKET',
  tailnetProxy: 'OTTER_TAILNET_PROXY',
  claudeBin: 'OTTER_CLAUDE',
  claudeArgs: 'OTTER_CLAUDE_ARGS',
  shellBin: 'OTTER_SHELL',
  agyBin: 'OTTER_AGY',
  taskDir: 'OTTER_TASK_DIR',
  nolaHelper: 'OTTER_NOLA_HELPER',
  nolaProjectsBoard: 'OTTER_NOLA_PROJECTS',
  nolaTodoBoards: 'OTTER_NOLA_TODOS',
};

/** Take effect right away; everything else when Otterdeck starts the next time. */
export const LIVE = new Set<SettingsKey>(['setupDone', 'openWindow', 'autostart', 'claudeArgs', 'sharedMemory', 'updateCheck']);

function fromEnv(key: SettingsKey): Settings[SettingsKey] | undefined {
  const name = ENV[key];
  const raw = name ? process.env[name] : undefined;
  if (raw === undefined || raw === '') return undefined;
  if (key === 'role') return raw === '1' ? 'server' : 'desktop';
  if (key === 'openWindow') return raw !== '1';
  if (typeof DEFAULTS[key] === 'number') return Number(raw) || (DEFAULTS[key] as number);
  return raw;
}

export const envFixed = (): SettingsKey[] => (Object.keys(ENV) as SettingsKey[]).filter((k) => fromEnv(k) !== undefined);

let file = '';
let saved: Settings = { ...DEFAULTS };
/** The values this process started with (environment applied). */
let boot: Settings = { ...DEFAULTS };

function clean(input: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!(k in DEFAULTS)) continue;
    const want = typeof DEFAULTS[k as SettingsKey];
    if (want === 'number') {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 65535) out[k] = Math.round(n);
    } else if (want === 'boolean') out[k] = !!v;
    else if (k === 'role') out[k] = v === 'server' ? 'server' : 'desktop';
    else if (typeof v === 'string') out[k] = v.trim();
  }
  return out as Partial<Settings>;
}

function withEnv(s: Settings): Settings {
  const out = { ...s } as Record<string, unknown>;
  for (const k of Object.keys(ENV) as SettingsKey[]) {
    const v = fromEnv(k);
    if (v !== undefined) out[k] = v;
  }
  return out as unknown as Settings;
}

/**
 * Reads the file once at start. Without one, an existing Otterdeck (state.json there) keeps working
 * as before: set up, with the shared memory it always had.
 */
export function loadSettings(dataDir: string): Settings {
  file = path.join(dataDir, 'settings.json');
  let stored: Partial<Settings> = {};
  try {
    stored = clean(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    // No file yet: an Otterdeck from before the settings keeps working as it did; a new one starts
    // with the setup. Written right away, so the next start does not take it for an old one.
    if (fs.existsSync(path.join(dataDir, 'state.json'))) stored = { setupDone: true, sharedMemory: true };
    saved = { ...DEFAULTS, ...stored };
    write();
  }
  saved = { ...DEFAULTS, ...stored };
  boot = withEnv(saved);
  return boot;
}

function write() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2));
  fs.renameSync(tmp, file);
}

/** What applies now: the start values, with the live settings as last saved. */
export function settings(): Settings {
  const now = withEnv(saved);
  const out = { ...boot } as Record<string, unknown>;
  for (const k of LIVE) out[k] = now[k];
  return out as unknown as Settings;
}

export const savedSettings = (): Settings => withEnv(saved);

/** Settings that were changed but only apply after a restart. */
export function needsRestart(): SettingsKey[] {
  const now = withEnv(saved);
  return (Object.keys(DEFAULTS) as SettingsKey[]).filter((k) => !LIVE.has(k) && now[k] !== boot[k]);
}

export function updateSettings(patch: Record<string, unknown>): Settings {
  const fixed = new Set(envFixed());
  const next = clean(patch);
  for (const k of Object.keys(next) as SettingsKey[]) if (fixed.has(k)) delete next[k];
  saved = { ...saved, ...next };
  write();
  return withEnv(saved);
}
