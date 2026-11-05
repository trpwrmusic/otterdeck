import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';
import type { UsageView, UsageWindow } from '../shared/types.ts';

// Plan usage limits per account, as Claude Code reports them to its status line (hook/otter-status.mjs).
// Only the newest report per account is kept; it survives restarts.

const FILE = path.join(DATA_DIR, 'usage.json');
export const accountKey = (dir: string) => path.resolve(dir).replace(/\\/g, '/').toLowerCase();

let store: Record<string, UsageView> = {};
try {
  store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {}

const LABELS: Record<string, string> = {
  five_hour: 'Aktuelle Sitzung',
  seven_day: 'Woche, alle Modelle',
  seven_day_opus: 'Woche, Opus',
  seven_day_sonnet: 'Woche, Sonnet',
  seven_day_oauth_apps: 'Woche, Apps',
};

/** resets_at may come as epoch seconds, epoch ms or an ISO string. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function windowOf(key: string, label: string, w: any): UsageWindow | null {
  if (!w || typeof w.used_percentage !== 'number') return null;
  return { key, label, percent: Math.max(0, Math.min(100, w.used_percentage)), resetsAt: toMs(w.resets_at) };
}

export function recordUsage(account: string, raw: any) {
  if (!raw || typeof raw !== 'object') return false;
  const windows: UsageWindow[] = [];
  for (const [key, label] of Object.entries(LABELS)) {
    const w = windowOf(key, label, raw[key]);
    if (w) windows.push(w);
  }
  if (Array.isArray(raw.model_scoped))
    raw.model_scoped.forEach((m: any, i: number) => {
      const w = windowOf(`model_${i}`, `Woche, ${m?.display_name ?? 'Modell'}`, m);
      if (w) windows.push(w);
    });
  if (!windows.length) return false;
  const prev = store[accountKey(account)];
  const next: UsageView = { account, at: Date.now(), windows };
  store[accountKey(account)] = next;
  // Write at most every few seconds' worth of change: the status line runs often.
  if (!prev || JSON.stringify(prev.windows) !== JSON.stringify(windows)) {
    try {
      fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
    } catch {}
    return true;
  }
  return false;
}

export function usageViews(): UsageView[] {
  return Object.values(store);
}
