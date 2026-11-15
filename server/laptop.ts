import type { LaptopView } from '../shared/types.ts';
import { SERVER_MODE } from './config.ts';
import { data } from './store.ts';
import { tailnetFetch } from './tailnet.ts';

// Server mode: the server is the central Otterdeck (phone opens it), and shows the laptop next to
// its own projects – online or not, and what its sessions are doing. The laptop tells the server its
// address (handoff.ts pollServer); here the server asks the laptop's /api/state over the tailnet.

let view: Omit<LaptopView, 'url'> = { online: null, checkedAt: 0, seenAt: 0, projects: [] };

const rank = { waiting: 3, working: 2, done: 1 } as const;

async function poll(changed: () => void) {
  const url = data.laptopUrl;
  if (!SERVER_MODE || !url) return;
  const before = JSON.stringify(view.projects) + view.online;
  try {
    const res = await tailnetFetch(url + '/api/state', { headers: { origin: url } });
    if (!res.ok) throw new Error(String(res.status));
    const st = await res.json();
    const projects: LaptopView['projects'] = (st.projects ?? [])
      .filter((p: any) => !p.free && p.exists !== false)
      .map((p: any) => {
        const tabs = (st.tabs ?? []).filter((t: any) => t.projectId === p.id);
        let attention: LaptopView['projects'][number]['attention'] = null;
        for (const t of tabs) {
          const a = t.status === 'waiting' ? 'waiting' : t.status === 'working' ? 'working' : t.status === 'done' && t.unseen ? 'done' : null;
          if (a && (!attention || rank[a] > rank[attention])) attention = a;
        }
        return { id: p.id, name: p.displayName ?? p.name ?? p.path, group: p.group ?? null, lastUsed: p.lastUsed ?? 0, tabs: tabs.length, attention };
      })
      .sort((a: any, b: any) => (b.attention ? rank[b.attention as keyof typeof rank] : 0) - (a.attention ? rank[a.attention as keyof typeof rank] : 0) || b.lastUsed - a.lastUsed);
    view = { online: true, checkedAt: Date.now(), seenAt: Date.now(), projects };
  } catch {
    // Keep the last known list, so the phone still sees what was there.
    view = { ...view, online: false, checkedAt: Date.now() };
  }
  if (before !== JSON.stringify(view.projects) + view.online) changed();
}

export function startLaptopPoll(changed: () => void) {
  if (!SERVER_MODE) return;
  poll(changed);
  setInterval(() => poll(changed), 15_000).unref();
}

/** Right after the laptop reported a (new) address. */
export const pollLaptopNow = (changed: () => void) => poll(changed);

export function laptopView(): LaptopView | null {
  if (!SERVER_MODE || !data.laptopUrl) return null;
  return { url: data.laptopUrl, ...view };
}
