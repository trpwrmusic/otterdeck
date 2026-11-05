import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import type { AppState, Chat, TabView } from '../../shared/types';
import { api, useAppState, usePersisted } from './api';
import { AddProject } from './AddProject';
import { ChatsPage } from './ChatsPage';
import { CommandPalette, type Command } from './CommandPalette';
import { ProjectPane } from './ProjectPane';
import { fullName, Sidebar, sidebarOrder } from './Sidebar';
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

  /** Narrow windows: the sidebar is a sheet that opens over the work. */
  // On a phone the project list comes first.
  const [navOpen, setNavOpen] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [palette, setPalette] = useState(false);
  const selectProject = useCallback(
    (id: string) => {
      setView('project');
      setSelected(id);
      setNavOpen(false);
    },
    [setSelected],
  );

  // Short messages from anywhere in the app (e.g. an icon that could not be stored).
  useEffect(() => {
    const on = (e: Event) => setToast({ text: String((e as CustomEvent).detail) });
    window.addEventListener('otter:toast', on);
    return () => window.removeEventListener('otter:toast', on);
  }, []);

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
    if (!before.size) return;
    for (const t of state.tabs) {
      const old = before.get(t.id);
      if (!old || old.status === t.status) continue;
      const looking = viewing.current.visible && viewing.current.tab === t.id;
      if (looking) continue;
      const p = state.projects.find((x) => x.id === t.projectId);
      const name = p ? fullName(p) : 'Claude';
      const waiting = t.status === 'waiting';
      const finished = t.status === 'done' && old.status === 'working';
      if (!waiting && !finished) continue;
      const title = waiting ? `${name} wartet auf dich` : `${name} ist fertig`;
      const body = waiting ? t.question ?? 'Claude braucht eine Antwort' : t.lastMessage ?? t.title;
      // In the window: a short note with a way there. Outside it: a Windows notification.
      if (viewing.current.visible) setToast({ text: title, action: { label: waiting ? 'Antworten' : 'Ansehen', run: () => openTabRef.current(t.id) } });
      else if (permission === 'granted') notify(title, body, t.id, openTabRef);
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
        case 'toggle-view':
          window.dispatchEvent(new Event('otter:toggle-view'));
          break;
        case 'palette':
          setPalette((o) => !o);
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

  /** What the palette offers to do, in the order it lists them. */
  function paletteActions(): Command[] {
    const pid = project?.id;
    const list: Command[] = [];
    if (pid) {
      list.push(
        { id: 'a:claude', group: 'Aktionen', title: `Neuer Chat in ${fullName(project!)}`, keys: 'Strg ⇧ Enter', run: () => api.newTab(pid, 'claude').then(({ id }) => activate(pid, id)) },
        { id: 'a:shell', group: 'Aktionen', title: `Neue Shell in ${fullName(project!)}`, keys: 'Strg ⇧ ^', run: () => api.newTab(pid, 'shell').then(({ id }) => activate(pid, id)) },
        { id: 'a:view', group: 'Aktionen', title: 'Terminal oder Chat umschalten', keys: 'Strg ⇧ Leer', run: () => window.dispatchEvent(new Event('otter:toggle-view')) },
        { id: 'a:panel', group: 'Aktionen', title: 'Änderungen ein- oder ausblenden', run: () => window.dispatchEvent(new Event('otter:toggle-panel')) },
      );
    }
    if (state!.tabs.some((t) => t.status === 'waiting'))
      list.push({ id: 'a:next', group: 'Aktionen', title: 'Zur Sitzung, die auf dich wartet', keys: 'Strg ⇧ J', run: () => {
        const t = state!.tabs.filter((x) => x.status === 'waiting').sort((a, b) => a.changedAt - b.changedAt)[0];
        if (t) openTab(t.id);
      } });
    list.push(
      { id: 'a:chats', group: 'Aktionen', title: 'Alle Chats durchsuchen', run: () => setView('chats') },
      { id: 'a:add', group: 'Aktionen', title: 'Projekt hinzufügen', run: () => setView('add') },
    );
    if (state!.update.available) list.push({ id: 'a:restart', group: 'Aktionen', title: 'Otterdeck neu starten (neue Version)', run: () => api.restart() });
    return list;
  }

  if (!state)
    return (
      <div className="boot">
        <img src="/icon.svg" alt="" />
        {!connected && <p>Otterdeck startet …</p>}
      </div>
    );

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      <button className="icon-btn menu-btn nav-toggle" onClick={() => setNavOpen(!navOpen)} aria-label="Projekte">
        <Menu size={18} />
      </button>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
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
        onPalette={() => setPalette(true)}
        onOpenTab={(pid, tid) => {
          selectProject(pid);
          if (tid) setTimeout(() => activate(pid, tid), 400);
        }}
        onJump={(status) => {
          // The oldest one first, and a different one than you're looking at when there are several.
          const list = state.tabs
            .filter((t) => t.status === status && (status !== 'done' || t.unseen))
            .sort((a, b) => a.changedAt - b.changedAt);
          const next = list.find((t) => t.id !== activeTab) ?? list[0];
          if (next) openTab(next.id);
        }}
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
          usage={state.usage ?? []}
          remote={state.remote}
          isRemote={!!state.isRemote}
          server={state.server}
          serverMode={state.serverMode}
          activeTab={activeTab}
          onActivate={(id) => activate(project.id, id)}
        />
      )}
      {palette && (
        <CommandPalette
          state={state}
          actions={paletteActions()}
          onOpenProject={selectProject}
          onOpenTab={openTab}
          onOpenChat={(chat) =>
            chat.projectId ? openChat(chat, chat.projectId) : (setView('chats'), setToast({ text: 'Zieh den Chat auf ein Projekt, um ihn dort fortzusetzen.' }))
          }
          onClose={() => setPalette(false)}
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
