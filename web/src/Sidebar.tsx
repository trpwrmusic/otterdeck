import { useState, type DragEvent, type MouseEvent } from 'react';
import { BellRing, ChevronRight, MessagesSquare, Pin, Plus, RefreshCw } from 'lucide-react';
import type { AppState, Chat, ProjectView, TabView } from '../../shared/types';
import { api, attentionOf, usePersisted } from './api';
import { ContextMenu, ProjectAvatar, StatusMark, type MenuItem } from './bits';
import { CHAT_MIME } from './ChatsPage';

const HOUR = 3600_000;

export function groupProjects(state: AppState, now = Date.now()) {
  const tabsOf = (p: ProjectView) => state.tabs.filter((t) => t.projectId === p.id);
  const pinned: ProjectView[] = [];
  const active: ProjectView[] = [];
  const recent: ProjectView[] = [];
  const older: ProjectView[] = [];
  for (const p of state.projects) {
    if (p.pinned) pinned.push(p);
    else if (attentionOf(tabsOf(p)) || now - p.lastUsed < 6 * HOUR) active.push(p);
    else if (now - p.lastUsed < 24 * HOUR) recent.push(p);
    else older.push(p);
  }
  // Active projects keep the order they were added in, so rows don't jump around while you work.
  const byUse = (a: ProjectView, b: ProjectView) => b.lastUsed - a.lastUsed;
  recent.sort(byUse);
  older.sort(byUse);
  return { pinned, active, recent, older };
}

/** Projects in the order the sidebar shows them (for keyboard navigation). */
export function sidebarOrder(state: AppState, showOlder: boolean) {
  const g = groupProjects(state);
  return [...g.pinned, ...g.active, ...g.recent, ...(showOlder ? g.older : [])];
}

function statusLine(p: ProjectView, tabs: TabView[]): { text: string; tone: 'accent' | 'normal' | 'quiet' } | null {
  const waiting = tabs.find((t) => t.status === 'waiting');
  if (waiting) return { text: waiting.question || 'Wartet auf dich', tone: 'accent' };
  const working = tabs.find((t) => t.status === 'working');
  if (working) return { text: working.activity || working.title || 'Arbeitet …', tone: 'normal' };
  const done = tabs.find((t) => t.status === 'done' && t.unseen);
  if (done) return { text: done.lastMessage || 'Fertig', tone: 'normal' };
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
  /** Opens the next session in that state. */
  onJump: (status: 'waiting' | 'working' | 'done') => void;
}

export function Sidebar(props: Props) {
  const { state, selectedId, onSelect, view, onAdd, onChats, dragging, onDropChat, notifyPermission, onEnableNotifications, onJump } = props;
  const waiting = state.tabs.filter((t) => t.status === 'waiting').length;
  const working = state.tabs.filter((t) => t.status === 'working').length;
  const done = state.tabs.filter((t) => t.status === 'done' && t.unseen).length;
  const adding = view !== 'project';
  const [showOlder, setShowOlder] = usePersisted('otter.showOlder', false);
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectView } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const groups = groupProjects(state);

  const dropProps = (p: ProjectView) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(CHAT_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (dropOn !== p.id) setDropOn(p.id);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOn((d) => (d === p.id ? null : d));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDropOn(null);
      try {
        onDropChat(p.id, JSON.parse(e.dataTransfer.getData(CHAT_MIME)));
      } catch {}
    },
  });

  const openMenu = (e: MouseEvent, project: ProjectView) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, project });
  };

  const menuItems = (p: ProjectView): MenuItem[] => {
    const items: MenuItem[] = [
      { label: p.pinned ? 'Nicht mehr anpinnen' : 'Anpinnen', onClick: () => api.updateProject(p.id, { pinned: !p.pinned }) },
      { label: 'Umbenennen …', onClick: () => setRenaming(p.id) },
    ];
    if (p.name) items.push({ label: 'Ordnernamen verwenden', onClick: () => api.updateProject(p.id, { name: null }) });
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
      {
        label: 'Aus Otterdeck entfernen',
        confirm: 'Wirklich entfernen? Der Ordner bleibt.',
        danger: true,
        onClick: () => api.removeProject(p.id),
      },
    );
    return items;
  };

  const row = (p: ProjectView, compact = false) => {
    const tabs = state.tabs.filter((t) => t.projectId === p.id);
    const attention = attentionOf(tabs);
    const line = compact && !attention ? null : statusLine(p, tabs);
    const selected = p.id === selectedId && !adding;
    return (
      <div
        key={p.id}
        className={`row${selected ? ' selected' : ''}${compact ? ' compact' : ''}${!p.exists ? ' missing' : ''}${dropOn === p.id ? ' drop' : ''}`}
        onClick={() => onSelect(p.id)}
        onContextMenu={(e) => openMenu(e, p)}
        title={p.path}
        {...dropProps(p)}
      >
        <ProjectAvatar project={p} size={compact ? 24 : 30} />
        <div className="row-text">
          {renaming === p.id ? (
            <input
              className="rename"
              autoFocus
              defaultValue={p.displayName}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  api.updateProject(p.id, { name: e.currentTarget.value });
                  setRenaming(null);
                } else if (e.key === 'Escape') setRenaming(null);
              }}
              onBlur={() => setRenaming(null)}
            />
          ) : (
            <div className="row-name">
              {p.displayName}
              {p.pinned && <Pin className="row-pin" size={11} strokeWidth={2.4} />}
            </div>
          )}
          {line && <div className={`row-line ${line.tone}`}>{line.text}</div>}
        </div>
        <div className="row-mark">
          <StatusMark attention={attention} />
        </div>
      </div>
    );
  };

  const section = (title: string, list: ProjectView[], compact = false) =>
    list.length > 0 && (
      <div className="section">
        <div className="section-title">{title}</div>
        {list.map((p) => row(p, compact))}
      </div>
    );

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/icon.svg" alt="" className="brand-icon" />
        <span className="brand-name">Otterdeck</span>
        <button className={`icon-btn${view === 'add' ? ' on' : ''}`} onClick={onAdd} title="Projekt hinzufügen">
          <Plus size={18} />
        </button>
      </div>

      {state.tabs.some((t) => t.kind === 'claude') && !waiting && !working && !done && <div className="pulse-quiet">Keine Sitzung braucht dich</div>}
      {(waiting > 0 || working > 0 || done > 0) && (
        <div className="pulse" aria-label="Sitzungen">
          <button
            className={`pulse-chip${waiting ? ' waiting' : ''}`}
            disabled={!waiting}
            onClick={() => onJump('waiting')}
            title="Zur nächsten wartenden Sitzung (Strg+Umschalt+J)"
          >
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

      <div className="nav">
        <button className={`nav-item${view === 'chats' ? ' on' : ''}`} onClick={onChats}>
          <MessagesSquare size={16} /> Chats
        </button>
      </div>

      <div className={`sidebar-scroll${dragging ? ' dragging' : ''}`}>
        {dragging && <div className="drop-hint">Auf ein Projekt ziehen</div>}
        {state.projects.length === 0 && (
          <button className="sidebar-empty" onClick={onAdd}>
            <Plus size={16} /> Erstes Projekt hinzufügen
          </button>
        )}
        {section('Angepinnt', groups.pinned)}
        {section('Aktiv', groups.active)}
        {section('Letzter Tag', groups.recent, true)}
        {groups.older.length > 0 && (
          <div className="section">
            <button className="section-title toggle" onClick={() => setShowOlder(!showOlder)}>
              <ChevronRight size={13} className={showOlder ? 'rot' : ''} /> Älter
              <span className="count">{groups.older.length}</span>
            </button>
            {(showOlder || dragging) && <div className="older">{groups.older.map((p) => row(p, true))}</div>}
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

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.project)} onClose={() => setMenu(null)} />}
    </aside>
  );
}
