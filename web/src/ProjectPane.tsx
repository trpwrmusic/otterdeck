import { useEffect, useRef, useState } from 'react';
import { CloudUpload, Orbit, FileCode2, FileDiff as FileDiffIcon, GitBranch, PanelRight, Plus, Sparkles, SquareTerminal, X } from 'lucide-react';
import type { AccountView, RemoteView, ServerView, UsageView, CompareMode, Conversation, ProjectView, TabView } from '../../shared/types';
import { api, timeAgo, usePersisted } from './api';
import { ContextMenu, Kbd, ProjectAvatar, StatusMark } from './bits';
import { ChangesPanel } from './ChangesPanel';
import { UsageCard } from './UsageCard';
import { RemoteCard } from './RemoteCard';
import { HandoffDialog, ServerCard } from './ServerParts';
import { NewChatButton } from './ModelPicker';
import { COMMENTS_LEAD, DiffView, FileView, formatComments, type ReviewComment } from './DiffView';
import { TerminalView } from './TerminalView';
import { ChatView } from './chat/ChatView';
import { Glide } from './Glide';

/** Diff and file tabs live only in this window, next to the terminal tabs. */
interface ViewTab {
  id: string; // "view:diff:<path>" | "view:file:<path>"
  kind: 'diff' | 'file';
  path: string;
}

interface Props {
  project: ProjectView;
  tabs: TabView[];
  accounts: AccountView[];
  usage: UsageView[];
  remote?: RemoteView;
  isRemote?: boolean;
  server?: ServerView | null;
  serverMode?: boolean;
  nola?: boolean;
  /** Antigravity CLI installed. */
  agy?: boolean;
  /** A NOLA task to show in the side panel (from the search). */
  focusTask?: number | null;
  activeTab: string | null; // null = start page
  onActivate: (tabId: string | null) => void;
}

function tabAttention(t: TabView) {
  if (t.status === 'waiting') return 'waiting' as const;
  if (t.status === 'working') return 'working' as const;
  if (t.status === 'done' && t.unseen) return 'done' as const;
  return null;
}

const RUNNING = new Set(['starting', 'ready', 'working', 'waiting', 'done']);
const fileName = (p: string) => p.split('/').pop() ?? p;

export function ProjectPane({ project, tabs, accounts, usage, remote, isRemote, server, serverMode, nola, agy, focusTask, activeTab, onActivate }: Props) {
  const [handoffTab, setHandoffTab] = useState<string | null>(null);
  // A NOLA task picked in the search shows up in the side panel, so the panel has to be open.
  useEffect(() => {
    if (focusTask) setPanelOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTask]);
  const [views, setViews] = usePersisted<ViewTab[]>(`otter.views.${project.id}`, []);
  const [comments, setComments] = usePersisted<ReviewComment[]>(`otter.comments.${project.id}`, []);
  const [panelOpen, setPanelOpen] = usePersisted('otter.panel', true);
  const [mode, setMode] = usePersisted<CompareMode>(`otter.mode.${project.id}`, 'head');
  const [sending, setSending] = useState(false);
  const lastClaude = useRef<string | null>(null);
  /** Per Claude tab: terminal or chat. */
  const [tabViews, setTabViews] = usePersisted<Record<string, 'chat' | 'terminal'>>('otter.tabViews', {});
  const [defaultView] = usePersisted<'chat' | 'terminal'>('otter.defaultView', 'chat');

  const currentView = views.find((v) => v.id === activeTab) ?? null;
  const current = currentView ? null : tabs.find((t) => t.id === activeTab) ?? (activeTab?.startsWith('view:') ? tabs[0] ?? null : null);
  if (current && (current.kind === 'claude' || current.kind === 'agy')) lastClaude.current = current.id;
  const viewOf = (t: TabView) => ((t.kind === 'claude' || t.kind === 'agy') ? tabViews[t.id] ?? defaultView : 'terminal');
  const setViewOf = (id: string, v: 'chat' | 'terminal') => setTabViews((m) => ({ ...m, [id]: v }));
  const currentMode = current ? viewOf(current) : 'terminal';

  // The palette can show or hide the changes panel.
  useEffect(() => {
    const t = () => setPanelOpen((o) => !o);
    window.addEventListener('otter:toggle-panel', t);
    return () => window.removeEventListener('otter:toggle-panel', t);
  }, [setPanelOpen]);

  // Ctrl+Shift+Space (see shortcuts.ts) flips the Claude tab in front.
  useEffect(() => {
    const flip = () => current && (current.kind === 'claude' || current.kind === 'agy') && setViewOf(current.id, viewOf(current) === 'chat' ? 'terminal' : 'chat');
    window.addEventListener('otter:toggle-view', flip);
    return () => window.removeEventListener('otter:toggle-view', flip);
  });
  const [accountMenu, setAccountMenu] = useState<{ x: number; y: number } | null>(null);
  const multi = accounts.length > 1;
  const accountOf = (dir: string | null | undefined) => accounts.find((a) => a.dir.toLowerCase() === (dir ?? '').toLowerCase());
  const projectDefault = accountOf(project.account) ?? accounts.find((a) => a.isDefault);
  // The header shows the account of the chat you're looking at, else the one new chats get.
  const shownAccount = multi ? (current?.kind === 'claude' ? accountOf(current.account) : null) ?? projectDefault : null;

  const open = async (kind: 'claude' | 'agy' | 'shell', resume?: string, account?: string, model?: string | null) => {
    const { id } = await api.newTab(project.id, kind, resume, undefined, account, model);
    onActivate(id);
  };

  const close = async (t: TabView) => {
    const all = [...tabs.map((x) => x.id), ...views.map((v) => v.id)];
    const i = all.indexOf(t.id);
    if (t.id === activeTab) onActivate(all[i + 1] ?? all[i - 1] ?? null);
    await api.closeTab(t.id);
  };

  const openView = (kind: 'diff' | 'file', path: string) => {
    const id = `view:${kind}:${path}`;
    if (!views.some((v) => v.id === id)) setViews((vs) => [...vs, { id, kind, path }]);
    onActivate(id);
  };

  const closeView = (v: ViewTab) => {
    const all = [...tabs.map((x) => x.id), ...views.map((x) => x.id)];
    const i = all.indexOf(v.id);
    if (v.id === activeTab) onActivate(all[i + 1] ?? all[i - 1] ?? null);
    setViews((vs) => vs.filter((x) => x.id !== v.id));
  };

  // A remembered view tab that is gone falls back to the start page.
  useEffect(() => {
    if (activeTab?.startsWith('view:') && !currentView && !tabs.length) onActivate(null);
  }, [activeTab, currentView, tabs.length, onActivate]);

  /** Sends all comments as one message: into the Claude tab you used last, or a new one. */
  const sendComments = async () => {
    if (!comments.length) return;
    setSending(true);
    const text = formatComments(comments);
    try {
      const claudeTabs = tabs.filter((t) => t.kind === 'claude' && RUNNING.has(t.status));
      const target = claudeTabs.find((t) => t.id === lastClaude.current) ?? claudeTabs[0];
      if (target) {
        await api.sendToTab(target.id, text, COMMENTS_LEAD);
        onActivate(target.id);
      } else {
        // A new tab gets everything as its first message (typed, not pasted).
        const { id } = await api.newTab(project.id, 'claude', undefined, `${COMMENTS_LEAD}\n\n${text}`);
        onActivate(id);
      }
      setComments([]);
    } finally {
      setSending(false);
    }
  };

  const hasTabs = tabs.length + views.length > 0;

  return (
    <main className="pane">
      <header className="pane-head">
        <div className="pane-title">
          {project.group && <span className="crumb">{project.group}</span>}
          <h1>{project.displayName}</h1>
          {project.branch && (
            <span className="pill">
              <GitBranch size={12} strokeWidth={2.4} /> {project.branch}
            </span>
          )}
          {shownAccount && (
            <span className="pill quiet" title={shownAccount.email ?? undefined}>
              {shownAccount.label}
            </span>
          )}
        </div>
        <div className="pane-actions">
          {current && (current.kind === 'claude' || current.kind === 'agy') && !currentView && (
            <div className="segmented view-switch" title="Strg+Umschalt+Leertaste">
              <Glide selector="button.on" watch={[currentMode, current.id]} />
              <button className={currentMode === 'terminal' ? 'on' : ''} onClick={() => setViewOf(current.id, 'terminal')}>
                Terminal
              </button>
              <button className={currentMode === 'chat' ? 'on' : ''} onClick={() => setViewOf(current.id, 'chat')}>
                Chat
              </button>
            </div>
          )}
          {current?.kind === 'claude' && !currentView && server?.tokenAt && !serverMode && (
            <button className="btn small" onClick={() => setHandoffTab(current.id)} title="Auf Server abgeben: Claude macht dort weiter, du kannst den Laptop zuklappen">
              <CloudUpload size={15} /> Auf Server
            </button>
          )}
          <button className="btn small" onClick={() => open('shell')} title="Shell öffnen (Strg+Umschalt+^)">
            <SquareTerminal size={15} /> Shell
          </button>
          <NewChatButton
            agy={!!agy}
            onStart={(c) => open(c.provider, undefined, undefined, c.model)}
            onContextMenu={(e) => {
              if (!multi) return;
              e.preventDefault();
              setAccountMenu({ x: e.clientX, y: e.clientY });
            }}
          />
          {accountMenu && (
            <ContextMenu
              x={accountMenu.x}
              y={accountMenu.y}
              onClose={() => setAccountMenu(null)}
              items={accounts.map((a) => ({
                label: `Neuer Chat mit ${a.label}`,
                hint: a.email ?? undefined,
                checked: a.dir === projectDefault?.dir,
                onClick: () => open('claude', undefined, a.dir),
              }))}
            />
          )}
          <button
            className={`icon-btn panel-toggle${panelOpen ? ' on' : ''}`}
            onClick={() => setPanelOpen(!panelOpen)}
            title={panelOpen ? 'Änderungen ausblenden' : 'Änderungen einblenden'}
          >
            <PanelRight size={18} />
          </button>
        </div>
      </header>

      {hasTabs && (
        <nav className="tabs">
          <Glide selector=".tab.active" watch={[activeTab, current?.id, currentView?.id, tabs.length, views.length, current?.title]} />
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab${t.id === current?.id ? ' active' : ''}`}
              onClick={() => onActivate(t.id)}
              onAuxClick={(e) => e.button === 1 && close(t)}
              title={t.lastPrompt ?? t.title}
            >
              <span className="tab-icon">
                {tabAttention(t) ? (
                  <StatusMark attention={tabAttention(t)} size={12} />
                ) : t.kind === 'claude' ? (
                  <Sparkles size={13} />
                ) : t.kind === 'agy' ? (
                  <Orbit size={13} />
                ) : (
                  <SquareTerminal size={13} />
                )}
              </span>
              <span className="tab-title">{t.title}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  close(t);
                }}
                title="Schließen"
              >
                <X size={13} />
              </button>
            </div>
          ))}
          {views.map((v) => (
            <div
              key={v.id}
              className={`tab view${v.id === currentView?.id ? ' active' : ''}`}
              onClick={() => onActivate(v.id)}
              onAuxClick={(e) => e.button === 1 && closeView(v)}
              title={v.path}
            >
              <span className="tab-icon">{v.kind === 'diff' ? <FileDiffIcon size={13} /> : <FileCode2 size={13} />}</span>
              <span className="tab-title">{fileName(v.path)}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeView(v);
                }}
                title="Schließen"
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button className={`tab add${activeTab === null ? ' active' : ''}`} onClick={() => onActivate(null)} title="Neuer Tab">
            <Plus size={14} />
          </button>
        </nav>
      )}

      <div className="sheet">
        <div className="pane-col">

          <div className="pane-body">
            {currentView ? (
              <div className="doc-card" key={currentView.id}>
                {currentView.kind === 'diff' ? (
                  <DiffView
                    project={project}
                    path={currentView.path}
                    mode={mode}
                    comments={comments}
                    onAddComment={(c) => setComments((cs) => [...cs, c])}
                    onRemoveComment={(c) => setComments((cs) => cs.filter((x) => x !== c))}
                    onSend={sendComments}
                    sending={sending}
                  />
                ) : (
                  <FileView project={project} path={currentView.path} />
                )}
              </div>
            ) : current && currentMode === 'chat' ? (
              <div className="doc-card chat-pane" key={`chat-${current.id}`}>
                <ChatView tab={current} onShowTerminal={() => setViewOf(current.id, 'terminal')} />
              </div>
            ) : current ? (
              <div className="term-card" key={current.id}>
                <TerminalView tab={current} active />
              </div>
            ) : (
              <StartPage project={project} accounts={accounts} onOpen={open}  agy={agy} />
            )}
          </div>
        </div>

        {handoffTab && <HandoffDialog tabId={handoffTab} onClose={() => setHandoffTab(null)} />}
        {panelOpen && (
          <ChangesPanel
            project={project}
            mode={mode}
            onMode={setMode}
            onOpenDiff={(p) => openView('diff', p)}
            onOpenFile={(p) => openView('file', p)}
            activePath={currentView?.path ?? null}
            nola={nola}
            focusTask={focusTask}
            onActivate={(id) => setTimeout(() => onActivate(id), 300)}
            footer={
              <>
              <UsageCard
                account={(current?.kind === 'claude' ? current.account : null) ?? tabs.find((t) => t.kind === 'claude')?.account ?? project.account}
                accounts={accounts}
                usage={usage}
              />
              {remote && !serverMode && <RemoteCard remote={remote} isRemote={!!isRemote} />}
              {!serverMode && !isRemote && <ServerCard server={server ?? null} projectId={project.id} onActivate={(id) => setTimeout(() => onActivate(id), 300)} />}
              </>
            }
          />
        )}
      </div>
    </main>
  );
}

function StartPage({
  project,
  accounts,
  onOpen,
  agy,
}: {
  project: ProjectView;
  accounts: AccountView[];
  onOpen: (kind: 'claude' | 'agy' | 'shell', resume?: string, account?: string, model?: string | null) => void;
  agy?: boolean;
}) {
  const label = (dir: string) => (accounts.length > 1 ? accounts.find((a) => a.dir.toLowerCase() === dir.toLowerCase())?.label : null);
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  useEffect(() => {
    let live = true;
    setConvs(null);
    api.conversations(project.id).then((c) => live && setConvs(c)).catch(() => live && setConvs([]));
    return () => {
      live = false;
    };
  }, [project.id, project.account]);

  return (
    <div className="start">
      <div className="start-hero">
        <ProjectAvatar project={project} size={64} />
        <h2>{project.displayName}</h2>
        <div className="start-path">{project.path}</div>
        <div className="start-actions">
          <NewChatButton big agy={!!agy} disabled={!project.exists} onStart={(c) => onOpen(c.provider, undefined, undefined, c.model)} />
          <button className="btn big" onClick={() => onOpen('shell')} disabled={!project.exists}>
            <SquareTerminal size={18} /> Shell
          </button>
        </div>
        <div className="start-hint">
          <Kbd>Strg</Kbd> <Kbd>Umschalt</Kbd> <Kbd>Enter</Kbd> startet Claude von überall
        </div>
      </div>

      {convs && convs.length > 0 && (
        <section className="start-recent">
          <h3>Weitermachen</h3>
          <div className="conv-grid">
            {convs.map((c) => (
              <button
                key={c.sessionId}
                className="conv"
                onClick={() => (c.provider === 'agy' ? onOpen('agy', c.sessionId) : onOpen('claude', c.sessionId, c.account))}
              >
                <span className="conv-title">{c.title}</span>
                <span className="conv-meta">
                  {c.provider === 'agy' ? (
                    <span className="pill quiet tiny agy-pill">
                      <Orbit size={10} /> Antigravity
                    </span>
                  ) : (
                    label(c.account) && <span className="pill quiet tiny">{label(c.account)}</span>
                  )}
                  <span className="conv-time">{timeAgo(c.updatedAt)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
