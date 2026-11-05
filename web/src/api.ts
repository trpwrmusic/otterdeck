import { useEffect, useState } from 'react';
import type {
  AppState,
  Changes,
  Chat,
  CompareMode,
  Conversation,
  DirEntry,
  EventMsg,
  FileContent,
  FileDiff,
  Suggestion,
  TabView,
} from '../../shared/types';

/** Fires "changes" (detail = projectId) when files in a watched project changed. */
export const fileChanges = new EventTarget();

/** Re-runs `load` whenever the project's files change. */
export function useOnFileChange(projectId: string, load: () => void) {
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent).detail === projectId && load();
    fileChanges.addEventListener('changes', on);
    return () => fileChanges.removeEventListener('changes', on);
  }, [projectId, load]);
}

async function call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json as T;
}

export const api = {
  addProject: (path: string) => call<{ id: string }>('POST', '/api/projects', { path }),
  updateProject: (id: string, patch: { name?: string | null; pinned?: boolean; account?: string | null }) =>
    call('PATCH', `/api/projects/${id}`, patch),
  removeProject: (id: string) => call('DELETE', `/api/projects/${id}`),
  reveal: (id: string) => call('POST', `/api/projects/${id}/reveal`, {}),
  conversations: (id: string) => call<Conversation[]>('GET', `/api/projects/${id}/conversations`),
  suggestions: () => call<Suggestion[]>('GET', '/api/suggestions'),
  chats: () => call<Chat[]>('GET', '/api/chats'),
  attachChat: (chat: Chat, projectId: string, open = false) =>
    call<{ copied: boolean; tabId: string | null }>('POST', '/api/chats/attach', {
      account: chat.account,
      dir: chat.dir,
      sessionId: chat.sessionId,
      projectId,
      open,
    }),
  dirs: (path: string) => call<string[]>('GET', `/api/fs/dirs?path=${encodeURIComponent(path)}`),
  newTab: (projectId: string, kind: 'claude' | 'shell', resume?: string, prompt?: string, account?: string) =>
    call<{ id: string }>('POST', '/api/tabs', { projectId, kind, resume, prompt, account }),
  sendToTab: (id: string, text: string, lead?: string) => call('POST', `/api/tabs/${id}/send`, { text, lead }),
  changes: (id: string, mode: CompareMode) => call<Changes>('GET', `/api/projects/${id}/changes?mode=${mode}`),
  diff: (id: string, path: string, mode: CompareMode) =>
    call<FileDiff>('GET', `/api/projects/${id}/diff?mode=${mode}&path=${encodeURIComponent(path)}`),
  files: (id: string, path: string) => call<DirEntry[]>('GET', `/api/projects/${id}/files?path=${encodeURIComponent(path)}`),
  file: (id: string, path: string) => call<FileContent>('GET', `/api/projects/${id}/file?path=${encodeURIComponent(path)}`),
  rawUrl: (id: string, path: string) => `/api/projects/${id}/raw?path=${encodeURIComponent(path)}`,
  closeTab: (id: string) => call('DELETE', `/api/tabs/${id}`),
  restartTab: (id: string, fresh = false) => call('POST', `/api/tabs/${id}/restart`, { fresh }),
  seen: (id: string) => call('POST', `/api/tabs/${id}/seen`, {}),
};

const wsUrl = (path: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
export const termUrl = (tab: string) => wsUrl(`/ws/term?tab=${encodeURIComponent(tab)}`);

/** Live app state, pushed by the server. Reconnects on its own. */
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: number | undefined;
    const open = () => {
      ws = new WebSocket(wsUrl('/ws/events'));
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as EventMsg;
        if (msg.t === 'state') setState(msg.state);
        else if (msg.t === 'changes') fileChanges.dispatchEvent(new CustomEvent('changes', { detail: msg.projectId }));
      };
      ws.onclose = () => {
        if (stop) return;
        setConnected(false);
        retry = window.setTimeout(open, 1000);
      };
    };
    open();
    return () => {
      stop = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
  return { state, connected };
}

// ---------- helpers ----------

export type Attention = 'waiting' | 'working' | 'done' | null;

/** The most urgent thing about a set of tabs. */
export function attentionOf(tabs: TabView[]): Attention {
  if (tabs.some((t) => t.status === 'waiting')) return 'waiting';
  if (tabs.some((t) => t.status === 'working')) return 'working';
  if (tabs.some((t) => t.status === 'done' && t.unseen)) return 'done';
  return null;
}

export function timeAgo(ms: number, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'gerade eben';
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  if (d === 1) return 'gestern';
  if (d < 7) return `vor ${d} Tagen`;
  return new Date(ms).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}

export function usePersisted<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue] as const;
}
