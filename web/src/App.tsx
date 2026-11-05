import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Chat, TabView } from '../../shared/types';
import { api, useAppState, usePersisted } from './api';
import { AddProject } from './AddProject';
import { ChatsPage } from './ChatsPage';
import { ProjectPane } from './ProjectPane';
import { Sidebar, sidebarOrder } from './Sidebar';
import { shortcutFor } from './shortcuts';

const notifySupported = typeof Notification !== 'undefined';

export function App() {
  const { state, connected } = useAppState();
  const [selected, setSelected] = usePersisted<string | null>('otter.project', null);
  /** Per project: which tab is in front (null = start page). */
  const [activeTabs, setActiveTabs] = usePersisted<Record<string, string | null>>('otter.tabs', {});
  const [view, setView] = useState<'project' | 'add' | 'chats'>('project');
  const adding = view !== 'project';
  const setAdding = (on: boolean) => setView(on ? 'add' : 'project');
  const [dragging, setDragging] = useState(false);
  const [chatsReload, setChatsReload] = useState(0);
  const [toast, setToast] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    notifySupported ? Notification.permission : 'unsupported',
  );
  const [visible, setVisible] = useState(!document.hidden && document.hasFocus());

  const project = state?.projects.find((p) => p.id === selected) ?? null;
  const tabs = state?.tabs.filter((t) => t.projectId === project?.id) ?? [];
  const stored = project ? activeTabs[project.id] : undefined;
  // A stored tab that no longer exists falls back to the first tab, or the start page.
  // Diff/file tabs ("view:…") are checked by the project pane itself.
  const activeTab =
    stored === null ? null : stored?.startsWith('view:') ? stored : tabs.find((t) => t.id === stored)?.id ?? tabs[0]?.id ?? null;

  const selectProject = useCallback(
    (id: string) => {
      setView('project');
      setSelected(id);
    },
    [setSelected],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  /** Continue a chat inside a project (copies it there first if needed). */
  const openChat = useCallback(
    async (chat: Chat, projectId: string) => {
      try {
        const { tabId } = await api.attachChat(chat, projectId, true);
        selectProject(projectId);
        if (tabId) activate(projectId, tabId);
      } catch (e) {
        setToast({ text: (e as Error).message });
      }
    },
    [selectProject],
  );

  const dropChat = useCallback(
    async (projectId: string, chat: Chat) => {
      setDragging(false);
      const name = state?.projects.find((p) => p.id === projectId)?.displayName ?? 'das Projekt';
      try {
        const { copied } = await api.attachChat(chat, projectId);
        setChatsReload((n) => n + 1);
        setToast({
          text: copied ? `„${chat.title}“ liegt jetzt bei ${name}` : `„${chat.title}“ liegt schon bei ${name}`,
          action: { label: 'Fortsetzen', run: () => openChat(chat, projectId) },
        });
      } catch (e) {
        setToast({ text: (e as Error).message });
      }
    },
    [state, openChat],
  );
  const activate = useCallback(
    (projectId: string, tabId: string | null) => setActiveTabs((m) => ({ ...m, [projectId]: tabId })),
    [setActiveTabs],
  );

  // Select something sensible once the state arrives.
  useEffect(() => {
    if (state && (!selected || !state.projects.some((p) => p.id === selected)) && state.projects.length)
      setSelected(sidebarOrder(state, false)[0]?.id ?? state.projects[0].id);
  }, [state, selected, setSelected]);

  // ---------- visibility & "seen" ----------
  useEffect(() => {
    const update = () => setVisible(!document.hidden && document.hasFocus());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const current = tabs.find((t) => t.id === activeTab);
  useEffect(() => {
    if (visible && !adding && current?.unseen) api.seen(current.id).catch(() => {});
  }, [visible, adding, current?.id, current?.unseen]);

  // ---------- notifications ----------
  const prev = useRef<Map<string, TabView>>(new Map());
  const viewing = useRef<{ tab: string | null; visible: boolean }>({ tab: null, visible });
  viewing.current = { tab: adding ? null : activeTab, visible };

  const openTab = useCallback(
    (tabId: string) => {
      const t = state?.tabs.find((x) => x.id === tabId);
      if (!t) return;
      selectProject(t.projectId);
      activate(t.projectId, t.id);
    },
    [state, selectProject, activate],
  );
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;

  useEffect(() => {
    if (!state) return;
    const before = prev.current;
    const next = new Map(state.tabs.map((t) => [t.id, t]));
    prev.current = next;
    if (!before.size || permission !== 'granted') return;
    for (const t of state.tabs) {
      const old = before.get(t.id);
      if (!old || old.status === t.status) continue;
      const looking = viewing.current.visible && viewing.current.tab === t.id;
      if (looking) continue;
      const p = state.projects.find((x) => x.id === t.projectId);
      const name = p?.displayName ?? 'Claude';
      if (t.status === 'waiting') notify(`${name} wartet auf dich`, t.question ?? 'Claude braucht eine Antwort', t.id, openTabRef);
      else if (t.status === 'done' && old.status === 'working')
        notify(`${name} ist fertig`, t.lastMessage ?? t.title, t.id, openTabRef);
    }
  }, [state, permission]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      const onMsg = (e: MessageEvent) => e.data?.type === 'open-tab' && e.data.tab && openTabRef.current(e.data.tab);
      navigator.serviceWorker.addEventListener('message', onMsg);
      return () => navigator.serviceWorker.removeEventListener('message', onMsg);
    }
  }, []);

  // ---------- window title ----------
  useEffect(() => {
    const n = state?.tabs.filter((t) => t.status === 'waiting').length ?? 0;
    document.title = n ? `(${n}) Otterdeck` : 'Otterdeck';
  }, [state]);

  // ---------- shortcuts ----------
  const stateRef = useRef<AppState | null>(null);
  stateRef.current = state;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      const s = stateRef.current;
      if (!action || !s) return;
      e.preventDefault();
      const order = sidebarOrder(s, true);
      const pid = selected;
      const ptabs = s.tabs.filter((t) => t.projectId === pid);
      switch (action.type) {
        case 'next-attention': {
          const rank = (t: TabView) => (t.status === 'waiting' ? 0 : t.status === 'done' && t.unseen ? 1 : 9);
          const list = s.tabs.filter((t) => rank(t) < 9).sort((a, b) => rank(a) - rank(b) || a.changedAt - b.changedAt);
          const next = list.find((t) => t.id !== activeTab) ?? list[0];
          if (next) openTab(next.id);
          break;
        }
        case 'project': {
          const i = order.findIndex((p) => p.id === pid);
          const next = order[(i + action.delta + order.length) % order.length];
          if (next) selectProject(next.id);
          break;
        }
        case 'new-claude':
        case 'new-shell':
          if (pid)
            api.newTab(pid, action.type === 'new-claude' ? 'claude' : 'shell').then(({ id }) => {
              setAdding(false);
              activate(pid, id);
            });
          break;
        case 'tab-index':
          if (pid && ptabs[action.index]) activate(pid, ptabs[action.index].id);
          break;
        case 'tab': {
          if (!pid || !ptabs.length) break;
          const i = ptabs.findIndex((t) => t.id === activeTab);
          const next = ptabs[(i + action.delta + ptabs.length) % ptabs.length];
          activate(pid, next.id);
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selected, activeTab, openTab, selectProject, activate]);

  if (!state)
    return (
      <div className="boot">
        <img src="/icon.svg" alt="" />
        {!connected && <p>Otterdeck startet …</p>}
      </div>
    );

  return (
    <div className="app">
      <Sidebar
        state={state}
        selectedId={project?.id ?? null}
        onSelect={selectProject}
        view={!project && view === 'project' ? 'add' : view}
        onAdd={() => setView('add')}
        onChats={() => setView('chats')}
        dragging={dragging}
        onDropChat={dropChat}
        notifyPermission={permission}
        onEnableNotifications={() => Notification.requestPermission().then(setPermission)}
      />
      {view === 'chats' ? (
        <ChatsPage
          projects={state.projects}
          accounts={state.accounts}
          reload={chatsReload}
          onDragState={setDragging}
          onOpen={(chat) =>
            chat.projectId
              ? openChat(chat, chat.projectId)
              : setToast({ text: 'Dieser Chat gehört noch zu keinem Projekt. Zieh ihn auf eins in der Seitenleiste.' })
          }
        />
      ) : adding || !project ? (
        <AddProject
          onAdded={(id) => {
            setAdding(false);
            setSelected(id);
          }}
        />
      ) : (
        <ProjectPane
          key={project.id}
          project={project}
          tabs={tabs}
          accounts={state.accounts}
          activeTab={activeTab}
          onActivate={(id) => activate(project.id, id)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="btn small primary"
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      {!connected && <div className="offline">Verbindung zu Otterdeck getrennt. Neuer Versuch läuft …</div>}
    </div>
  );
}

async function notify(title: string, body: string, tab: string, open: { current: (id: string) => void }) {
  const options: NotificationOptions = { body, icon: '/icon-192.png', tag: tab, data: { tab } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return reg.showNotification(title, options);
  } catch {}
  const n = new Notification(title, options);
  n.onclick = () => {
    window.focus();
    open.current(tab);
    n.close();
  };
}
