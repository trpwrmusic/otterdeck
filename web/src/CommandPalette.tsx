import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CornerDownLeft, FolderGit2, History, Search } from 'lucide-react';
import type { AppState, Chat } from '../../shared/types';
import { api, attentionOf, timeAgo } from './api';
import { ProjectAvatar, StatusMark } from './bits';
import { chatPlace } from './ChatsPage';

export interface Command {
  id: string;
  group: 'Aktionen' | 'Sitzungen' | 'Projekte' | 'Chats';
  title: string;
  hint?: string;
  keys?: string;
  icon?: ReactNode;
  run: () => void;
}

/** Fuzzy match: every typed letter in order; earlier, contiguous and word-start hits score higher. */
function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 + (direct === 0 || /[\s/\-_.]/.test(t[direct - 1]) ? 200 : 0);
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    run = i === ti ? run + 1 : 0;
    s += 10 + run * 6 - Math.min(i - ti, 8);
    ti = i + 1;
  }
  return s;
}

interface Props {
  state: AppState;
  actions: Command[];
  onOpenProject: (id: string) => void;
  onOpenTab: (id: string) => void;
  onOpenChat: (chat: Chat) => void;
  onClose: () => void;
}

export function CommandPalette({ state, actions, onOpenProject, onOpenTab, onOpenChat, onClose }: Props) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [chats, setChats] = useState<Chat[]>([]);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chats().then(setChats).catch(() => {});
  }, []);

  const commands = useMemo<Command[]>(() => {
    const project = (id: string) => state.projects.find((p) => p.id === id);
    const sessions: Command[] = state.tabs
      .filter((t) => t.kind === 'claude' && t.status !== 'dormant')
      .sort((a, b) => b.changedAt - a.changedAt)
      .map((t) => {
        const p = project(t.projectId);
        const att = attentionOf([t]);
        return {
          id: `tab:${t.id}`,
          group: 'Sitzungen',
          title: t.title,
          hint: [p?.displayName, t.status === 'waiting' ? t.question : t.activity].filter(Boolean).join(' · '),
          icon: att ? <StatusMark attention={att} size={13} /> : <History size={15} />,
          run: () => onOpenTab(t.id),
        };
      });
    const projects: Command[] = state.projects.map((p) => ({
      id: `project:${p.id}`,
      group: 'Projekte',
      title: p.displayName,
      hint: p.branch ?? p.path,
      icon: <ProjectAvatar project={p} size={20} />,
      run: () => onOpenProject(p.id),
    }));
    const past: Command[] = chats.slice(0, 60).map((c) => ({
      id: `chat:${c.account}:${c.sessionId}`,
      group: 'Chats',
      title: c.title,
      hint: `${chatPlace(c, state.projects).label} · ${timeAgo(c.updatedAt)}`,
      icon: <History size={15} />,
      run: () => onOpenChat(c),
    }));
    return [...actions, ...sessions, ...projects, ...past];
  }, [state, actions, chats, onOpenProject, onOpenTab, onOpenChat]);

  const shown = useMemo(() => {
    const query = q.trim();
    if (!query) {
      // Without a query: actions, then what's going on, then projects; past chats only when searched.
      return commands.filter((c) => c.group !== 'Chats').slice(0, 40);
    }
    const hits = commands
      .map((c) => ({ c, s: Math.max(score(c.title, query), score(c.hint ?? '', query) * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
    // One heading per group: groups appear in the order of their best hit.
    const order: string[] = [];
    for (const h of hits) if (!order.includes(h.group)) order.push(h.group);
    return order.flatMap((g) => hits.filter((h) => h.group === g));
  }, [commands, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };

  let lastGroup = '';
  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Befehle">
        <div className="palette-input">
          <Search size={17} />
          <input
            autoFocus
            value={q}
            placeholder="Projekt, Sitzung, Chat oder Befehl"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(shown.length - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(shown[sel]);
              } else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="palette-list" ref={list}>
          {shown.length === 0 && <div className="palette-empty">Nichts gefunden für „{q}“</div>}
          {shown.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="palette-group">{head}</div>}
                <button
                  data-i={i}
                  className={`palette-item${i === sel ? ' sel' : ''}`}
                  onMouseMove={() => i !== sel && setSel(i)}
                  onClick={() => run(c)}
                >
                  <span className="palette-icon">{c.icon ?? <FolderGit2 size={15} />}</span>
                  <span className="palette-title">{c.title}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                  {c.keys ? <kbd className="kbd">{c.keys}</kbd> : i === sel ? <CornerDownLeft size={14} className="palette-enter" /> : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
