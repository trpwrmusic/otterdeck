import { useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { BellRing, ChevronRight, MessagesSquare, Pin, Plus, RefreshCw, Search } from 'lucide-react';
import type { AppState, Chat, ProjectView, TabView } from '../../shared/types';
import { api, attentionOf, usePersisted } from './api';
import { ContextMenu, ProjectAvatar, StatusMark, type MenuItem } from './bits';
import { CHAT_MIME } from './ChatsPage';
import { Glide } from './Glide';

const HOUR = 3600_000;
/** Dragging a project row onto another row or a group puts them together. */
const PROJECT_MIME = 'application/x-otter-project';

export type Entry = { kind: 'project'; p: ProjectView } | { kind: 'group'; name: string; projects: ProjectView[] };

export type ActiveSort = 'alpha' | 'recent';

/** When something last happened in a project's chats: your input, or Claude working, asking or finishing. */
function lastActivity(state: AppState, p: ProjectView) {
  let t = Math.max(p.lastUsed, p.lastChat ?? 0);
  // Only real work moves a project up: a tab that is starting or resuming after a restart doesn't.
  for (const tab of state.tabs)
    if (tab.projectId === p.id && tab.kind === 'claude' && (tab.status === 'working' || tab.status === 'waiting' || (tab.status === 'done' && tab.unseen)))
      t = Math.max(t, tab.changedAt);
  return t;
}

/** Sections of the sidebar; a group sits in the section of its liveliest project. */
export function groupProjects(state: AppState, sort: ActiveSort = 'alpha', now = Date.now()) {
  const tabsOf = (p: ProjectView) => state.tabs.filter((t) => t.projectId === p.id);
  const activity = new Map(state.projects.map((p) => [p.id, lastActivity(state, p)]));
  // Sections go by real activity: a chat or your use, not when a project was added.
  const rank = (p: ProjectView) => {
    const at = activity.get(p.id)!;
    return p.pinned ? 0 : attentionOf(tabsOf(p)) || now - at < 6 * HOUR ? 1 : now - at < 24 * HOUR ? 2 : 3;
  };
  const sections: Entry[][] = [[], [], [], []];
  const groups = new Map<string, ProjectView[]>();
  for (const p of state.projects) {
    if (p.group) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
    else sections[rank(p)].push({ kind: 'project', p });
  }
  for (const [name, projects] of groups) {
    const best = Math.min(...projects.map(rank));
    projects.sort((a, b) =>
      sort === 'recent' ? activity.get(b.id)! - activity.get(a.id)! : a.displayName.localeCompare(b.displayName, 'de'),
    );
    sections[best].push({ kind: 'group', name, projects });
  }
  // Pinned and active: A–Z keeps rows still while you work, "recent" puts the latest chat on top.
  // The quieter sections always go by last use.
  const lastUse = (e: Entry) => (e.kind === 'project' ? activity.get(e.p.id)! : Math.max(...e.projects.map((p) => activity.get(p.id)!)));
  const latest = (e: Entry) => (e.kind === 'project' ? activity.get(e.p.id)! : Math.max(...e.projects.map((p) => activity.get(p.id)!)));
  const label = (e: Entry) => (e.kind === 'project' ? e.p.displayName : e.name);
  const bySort = (a: Entry, b: Entry) => (sort === 'recent' ? latest(b) - latest(a) : label(a).localeCompare(label(b), 'de'));
  sections[0].sort(bySort);
  sections[1].sort(bySort);
  sections[2].sort((a, b) => lastUse(b) - lastUse(a));
  sections[3].sort((a, b) => lastUse(b) - lastUse(a));
  const [pinned, active, recent, older] = sections;
  return { pinned, active, recent, older };
}

/** The sort choice as stored by the sidebar (keyboard navigation follows the same order). */
function readSort(): ActiveSort {
  try {
    return JSON.parse(localStorage.getItem('otter.activeSort') ?? '"alpha"') === 'recent' ? 'recent' : 'alpha';
  } catch {
    return 'alpha';
  }
}

const flat = (list: Entry[]) => list.flatMap((e) => (e.kind === 'project' ? [e.p] : e.projects));

/** Projects in the order the sidebar shows them (for keyboard navigation). */
export function sidebarOrder(state: AppState, showOlder: boolean, sort: ActiveSort = readSort()) {
  const g = groupProjects(state, sort);
  return [...flat(g.pinned), ...flat(g.active), ...flat(g.recent), ...(showOlder ? flat(g.older) : [])];
}

/** "Heidehof · App" when a project is part of a group. */
export const fullName = (p: ProjectView) => (p.group ? `${p.group} · ${p.displayName}` : p.displayName);

function statusLine(p: ProjectView | null, tabs: TabView[]): { text: string; tone: 'accent' | 'normal' | 'quiet' } | null {
  const waiting = tabs.find((t) => t.status === 'waiting');
  if (waiting) return { text: waiting.question || 'Wartet auf dich', tone: 'accent' };
  const working = tabs.find((t) => t.status === 'working');
  if (working) return { text: working.activity || working.title || 'Arbeitet …', tone: 'normal' };
  const done = tabs.find((t) => t.status === 'done' && t.unseen);
  if (done) return { text: done.lastMessage || 'Fertig', tone: 'normal' };
  if (!p) return null;
  if (!p.exists) return { text: 'Ordner nicht gefunden', tone: 'quiet' };
  if (p.branch) return { text: p.branch, tone: 'quiet' };
  return null;
}

interface Props {
  state: AppState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  view: 'project' | 'add' | 'chats';
  onAdd: () => void;
  onChats: () => void;
  /** A chat card is being dragged; project rows become drop targets. */
  dragging: boolean;
  onDropChat: (projectId: string, chat: Chat) => void;
  notifyPermission: NotificationPermission | 'unsupported';
  onEnableNotifications: () => void;
  onPalette: () => void;
  /** Opens the next session in that state. */
  onJump: (status: 'waiting' | 'working' | 'done') => void;
}

export function Sidebar(props: Props) {
  const { state, selectedId, onSelect, view, onAdd, onChats, dragging, onDropChat, notifyPermission, onEnableNotifications, onJump, onPalette } = props;
  const waiting = state.tabs.filter((t) => t.status === 'waiting').length;
  const working = state.tabs.filter((t) => t.status === 'working').length;
  const done = state.tabs.filter((t) => t.status === 'done' && t.unseen).length;
  const adding = view !== 'project';
  const [showOlder, setShowOlder] = usePersisted('otter.showOlder', false);
  const [closedGroups, setClosedGroups] = usePersisted<Record<string, boolean>>('otter.closedGroups', {});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** What is being renamed inline: a project (its id) or a group ("group:<name>"), or a new group for a project. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [movingProject, setMovingProject] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ id: string; top: number } | null>(null);
  const peekTimer = useRef<number | undefined>(undefined);
  const peekSoon = (id: string | null, el?: HTMLElement) => {
    clearTimeout(peekTimer.current);
    if (!id || !el) return setPeek(null);
    const top = el.getBoundingClientRect().top;
    peekTimer.current = window.setTimeout(() => setPeek({ id, top }), 450);
  };
  const [sort, setSort] = usePersisted<ActiveSort>('otter.activeSort', 'alpha');
  const sections = groupProjects(state, sort);
  const groupNames = [...new Set(state.projects.map((p) => p.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, 'de'));
  const tabsOf = (ids: string[]) => state.tabs.filter((t) => ids.includes(t.projectId));

  // ---------- drag & drop: chats onto projects, projects onto projects or groups ----------

  /** Puts `projectId` into the target: an existing group, or a new one with the target project. */
  const joinGroup = async (projectId: string, target: { group: string } | { project: ProjectView }) => {
    if ('group' in target) return api.updateProject(projectId, { group: target.group });
    const t = target.project;
    if (t.id === projectId) return;
    const name = t.group ?? t.displayName;
    if (!t.group) await api.updateProject(t.id, { group: name });
    await api.updateProject(projectId, { group: name });
  };

  const dropProps = (key: string, onChat: ((c: Chat) => void) | null, onProject: (id: string) => void) => ({
    onDragOver: (e: DragEvent) => {
      const types = e.dataTransfer.types;
      if (!(onChat && types.includes(CHAT_MIME)) && !types.includes(PROJECT_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = types.includes(PROJECT_MIME) ? 'move' : 'copy';
      if (dropOn !== key) setDropOn(key);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOn((d) => (d === key ? null : d));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropOn(null);
      setMovingProject(null);
      const pid = e.dataTransfer.getData(PROJECT_MIME);
      if (pid) return onProject(pid);
      try {
        if (onChat) onChat(JSON.parse(e.dataTransfer.getData(CHAT_MIME)));
      } catch {}
    },
  });

  // ---------- menus ----------

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const projectMenu = (p: ProjectView): MenuItem[] => {
    const items: MenuItem[] = [
      { label: p.pinned ? 'Nicht mehr anpinnen' : 'Anpinnen', onClick: () => api.updateProject(p.id, { pinned: !p.pinned }) },
      { label: 'Umbenennen …', onClick: () => setRenaming(p.id) },
    ];
    if (p.name) items.push({ label: 'Ordnernamen verwenden', onClick: () => api.updateProject(p.id, { name: null }) });
    // Groups
    const others = groupNames.filter((g) => g !== p.group);
    others.forEach((g, i) => items.push({ label: `In Gruppe „${g}“`, separatorBefore: i === 0, onClick: () => api.updateProject(p.id, { group: g }) }));
    items.push({ label: 'Neue Gruppe …', separatorBefore: others.length === 0, onClick: () => setRenaming(`newgroup:${p.id}`) });
    if (p.group) items.push({ label: `Aus „${p.group}“ herausnehmen`, onClick: () => api.updateProject(p.id, { group: null }) });
    if (state.accounts.length > 1) {
      state.accounts.forEach((a, i) =>
        items.push({
          label: `Neue Chats mit ${a.label}`,
          hint: a.email ?? undefined,
          checked: (p.account ?? state.accounts.find((x) => x.isDefault)?.dir) === a.dir,
          separatorBefore: i === 0,
          onClick: () => api.updateProject(p.id, { account: a.isDefault ? null : a.dir }),
        }),
      );
    }
    items.push(
      { label: 'Im Explorer öffnen', onClick: () => api.reveal(p.id), separatorBefore: true },
      { label: 'Aus Otterdeck entfernen', confirm: 'Wirklich entfernen? Der Ordner bleibt.', danger: true, onClick: () => api.removeProject(p.id) },
    );
    return items;
  };

  const groupMenu = (name: string): MenuItem[] => [
    { label: 'Gruppe umbenennen …', onClick: () => setRenaming(`group:${name}`) },
    { label: 'Gruppe auflösen', hint: 'Projekte bleiben', onClick: () => api.renameGroup(name, '') },
  ];

  const renameInput = (initial: string, onDone: (value: string) => void) => (
    <input
      className="rename"
      autoFocus
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const v = e.currentTarget.value.trim();
          if (v) onDone(v);
          setRenaming(null);
        } else if (e.key === 'Escape') setRenaming(null);
      }}
      onBlur={() => setRenaming(null)}
    />
  );

  // ---------- rows ----------

  const row = (p: ProjectView, opts: { compact?: boolean; child?: boolean } = {}) => {
    const tabs = tabsOf([p.id]);
    const attention = attentionOf(tabs);
    const line = opts.compact && !attention ? null : statusLine(p, tabs);
    const selected = p.id === selectedId && !adding;
    const waitingTab = tabs.find((t) => t.status === 'waiting' && t.prompt?.kind === 'permission');
    const noOption = waitingTab?.prompt?.options.find((o) => /^no\b/i.test(o.label))?.n;
    return (
      <div
        key={p.id}
        className={`row${selected ? ' selected' : ''}${opts.compact ? ' compact' : ''}${opts.child ? ' child' : ''}${!p.exists ? ' missing' : ''}${dropOn === p.id ? ' drop' : ''}${movingProject === p.id ? ' moving' : ''}`}
        draggable={renaming !== p.id}
        onDragStart={(e) => {
          e.dataTransfer.setData(PROJECT_MIME, p.id);
          e.dataTransfer.effectAllowed = 'move';
          setMovingProject(p.id);
          setPeek(null);
        }}
        onDragEnd={() => setMovingProject(null)}
        onClick={() => onSelect(p.id)}
        onContextMenu={(e) => openMenu(e, projectMenu(p))}
        onMouseEnter={(e) => peekSoon(p.id, e.currentTarget)}
        onMouseLeave={() => peekSoon(null)}
        {...dropProps(p.id, (c) => onDropChat(p.id, c), (pid) => joinGroup(pid, { project: p }))}
      >
        <ProjectAvatar project={p} size={opts.compact || opts.child ? 24 : 30} />
        <div className="row-text">
          {renaming === p.id ? (
            renameInput(p.displayName, (v) => api.updateProject(p.id, { name: v }))
          ) : renaming === `newgroup:${p.id}` ? (
            renameInput(p.displayName, (v) => api.updateProject(p.id, { group: v }))
          ) : (
            <div className="row-name">
              {p.displayName}
              {p.pinned && <Pin className="row-pin" size={11} strokeWidth={2.4} />}
            </div>
          )}
          {line && <div className={`row-line ${line.tone}`}>{line.text}</div>}
          {waitingTab && (
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              <button className="mini primary" onClick={() => api.choose(waitingTab.id, 1)}>
                Erlauben
              </button>
              {noOption !== undefined && (
                <button className="mini" onClick={() => api.choose(waitingTab.id, noOption)}>
                  Ablehnen
                </button>
              )}
            </div>
          )}
        </div>
        <div className="row-mark">
          <StatusMark attention={attention} />
        </div>
      </div>
    );
  };

  const groupBlock = (g: { name: string; projects: ProjectView[] }, compact = false) => {
    const open = !closedGroups[g.name] || dragging || !!movingProject;
    const tabs = tabsOf(g.projects.map((p) => p.id));
    const attention = attentionOf(tabs);
    const line = statusLine(null, tabs);
    const holdsSelected = g.projects.some((p) => p.id === selectedId) && !adding;
    const key = `group:${g.name}`;
    return (
      <div key={key} className={`group${open ? ' open' : ''}`}>
        <div
          className={`row group-head${compact ? ' compact' : ''}${dropOn === key ? ' drop' : ''}${holdsSelected && !open ? ' holds' : ''}`}
          onClick={() => setClosedGroups((m) => ({ ...m, [g.name]: open }))}
          onContextMenu={(e) => openMenu(e, groupMenu(g.name))}
          {...dropProps(key, null, (pid) => joinGroup(pid, { group: g.name }))}
        >
          <span className="group-tile" style={{ width: compact ? 24 : 30, height: compact ? 24 : 30 }}>
            {g.name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase()}
          </span>
          <div className="row-text">
            {renaming === key ? (
              renameInput(g.name, (v) => api.renameGroup(g.name, v))
            ) : (
              <div className="row-name">
                {g.name}
                <span className="group-count">{g.projects.length}</span>
              </div>
            )}
            {(!open || compact) && line && <div className={`row-line ${line.tone}`}>{line.text}</div>}
          </div>
          <div className="row-mark">
            {!open && attention ? <StatusMark attention={attention} /> : <ChevronRight size={14} className={`group-chev${open ? ' rot' : ''}`} />}
          </div>
        </div>
        {open && <div className="group-children">{g.projects.map((p) => row(p, { child: true }))}</div>}
      </div>
    );
  };

  const entries = (list: Entry[], compact = false) =>
    list.map((e) => (e.kind === 'project' ? row(e.p, { compact }) : groupBlock(e, compact)));

  const section = (title: string, list: Entry[], compact = false, sortable = false) =>
    list.length > 0 && (
      <div className="section">
        <div className="section-title">
          {title}
          {sortable && (
            <button
              className="section-sort"
              onClick={() => setSort(sort === 'alpha' ? 'recent' : 'alpha')}
              title={sort === 'alpha' ? 'Sortiert nach Name · klicken: zuletzt benutzt zuerst' : 'Zuletzt benutzt zuerst · klicken: nach Name'}
            >
              {sort === 'alpha' ? 'A–Z' : 'Zuletzt'}
            </button>
          )}
        </div>
        {entries(list, compact)}
      </div>
    );

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/mark.svg" alt="" className="brand-icon" />
        <span className="brand-name">Otterdeck</span>
        <button className={`icon-btn${view === 'add' ? ' on' : ''}`} onClick={onAdd} title="Projekt hinzufügen">
          <Plus size={18} />
        </button>
      </div>

      {state.tabs.some((t) => t.kind === 'claude') && !waiting && !working && !done && <div className="pulse-quiet">Keine Sitzung braucht dich</div>}
      {(waiting > 0 || working > 0 || done > 0) && (
        <div className="pulse" aria-label="Sitzungen">
          <button className={`pulse-chip${waiting ? ' waiting' : ''}`} disabled={!waiting} onClick={() => onJump('waiting')} title="Zur nächsten wartenden Sitzung (Strg+Umschalt+J)">
            {waiting > 0 && <span className="mark waiting" style={{ width: 8, height: 8 }} />}
            <b>{waiting}</b> warten
          </button>
          <button className="pulse-chip" disabled={!working} onClick={() => onJump('working')} title="Zur nächsten arbeitenden Sitzung">
            {working > 0 && <span className="mark working" style={{ width: 11, height: 11 }} />}
            <b>{working}</b> aktiv
          </button>
          {done > 0 && (
            <button className="pulse-chip" onClick={() => onJump('done')} title="Zur nächsten fertigen Sitzung">
              <b>{done}</b> fertig
            </button>
          )}
        </div>
      )}

      <button className="search" onClick={onPalette}>
        <Search size={14} />
        <span>Suchen oder Befehl</span>
        <kbd className="kbd">Strg K</kbd>
      </button>

      <div className="nav">
        <button className={`nav-item${view === 'chats' ? ' on' : ''}`} onClick={onChats}>
          <MessagesSquare size={16} /> Chats
        </button>
      </div>

      <div className={`sidebar-scroll${dragging ? ' dragging' : ''}${movingProject ? ' moving-project' : ''}`}>
        <Glide
          selector=".row.selected"
          watch={[selectedId, adding, state.projects.length, showOlder, sort, JSON.stringify(closedGroups), flat([...sections.pinned, ...sections.active]).map((p) => p.id + (p.group ?? '')).join('|')]}
        />
        {dragging && <div className="drop-hint">Auf ein Projekt ziehen</div>}
        {movingProject && <div className="drop-hint">Auf ein Projekt oder eine Gruppe ziehen</div>}
        {state.projects.length === 0 && (
          <button className="sidebar-empty" onClick={onAdd}>
            <Plus size={16} /> Erstes Projekt hinzufügen
          </button>
        )}
        {section('Angepinnt', sections.pinned, false, !sections.active.length)}
        {section('Aktiv', sections.active, false, true)}
        {section('Letzter Tag', sections.recent, true)}
        {sections.older.length > 0 && (
          <div className="section">
            <button className="section-title toggle" onClick={() => setShowOlder(!showOlder)}>
              <ChevronRight size={13} className={showOlder ? 'rot' : ''} /> Älter
              <span className="count">{sections.older.length}</span>
            </button>
            {(showOlder || dragging || movingProject) && <div className="older">{entries(sections.older, true)}</div>}
          </div>
        )}
      </div>

      {state.update.available && (
        <button className="notify-card update" onClick={() => !state.update.pending && api.restart()} disabled={state.update.pending}>
          <RefreshCw size={16} className={state.update.pending ? 'spinning' : ''} />
          <span>
            <strong>{state.update.pending ? 'Neustart vorgemerkt' : 'Neue Version'}</strong>
            <span>{state.update.pending ? 'Sobald Claude fertig ist' : 'Neu starten, Gespräche bleiben'}</span>
          </span>
        </button>
      )}

      {notifyPermission === 'default' && state.projects.length > 0 && (
        <button className="notify-card" onClick={onEnableNotifications}>
          <BellRing size={16} />
          <span>
            <strong>Benachrichtigungen</strong>
            <span>Wenn Claude auf dich wartet</span>
          </span>
        </button>
      )}

      {peek && !menu && !dragging && !movingProject && <Peek state={state} projectId={peek.id} top={peek.top} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}

/** A small card beside a row: what Claude is doing or asking, and what it last said. */
function Peek({ state, projectId, top }: { state: AppState; projectId: string; top: number }) {
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return null;
  const tabs = state.tabs.filter((t) => t.projectId === p.id && t.kind === 'claude' && t.status !== 'dormant');
  return (
    <div className="peek" style={{ top: Math.min(top, window.innerHeight - 260) }}>
      <div className="peek-head">
        <span className="peek-name">{fullName(p)}</span>
        {p.branch && <span className="pill tiny">{p.branch}</span>}
      </div>
      <div className="peek-path">{p.path}</div>
      {tabs.length === 0 && <div className="peek-quiet">Keine laufende Sitzung</div>}
      {tabs.slice(0, 3).map((t) => (
        <div className="peek-tab" key={t.id}>
          <div className="peek-title">
            <StatusMark attention={attentionOf([t])} size={12} />
            <span>{t.title}</span>
          </div>
          {t.status === 'waiting' && t.question && <div className="peek-line wait">{t.question}</div>}
          {t.status === 'working' && <div className="peek-line">{t.activity ?? 'Arbeitet …'}</div>}
          {t.lastPrompt && <div className="peek-line quiet">Du: {t.lastPrompt}</div>}
          {t.lastMessage && t.status !== 'working' && <div className="peek-line">{t.lastMessage}</div>}
        </div>
      ))}
    </div>
  );
}
