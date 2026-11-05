import { useEffect, useMemo, useState } from 'react';
import { Folder, Search } from 'lucide-react';
import type { AccountView, Chat, ProjectView } from '../../shared/types';
import { api, timeAgo } from './api';
import { ProjectAvatar } from './bits';
import { Glide } from './Glide';

export const CHAT_MIME = 'application/x-otter-chat';

const HOME_RE = /^[a-z]:\\users\\[^\\]+$/i;

/** Where a chat ran, in words: the project, "Benutzerordner", or the folder name. */
export function chatPlace(chat: Chat, projects: ProjectView[]) {
  const project = chat.projectId ? projects.find((p) => p.id === chat.projectId) ?? null : null;
  if (project) return { project, label: project.displayName };
  if (chat.cwd && HOME_RE.test(chat.cwd)) return { project: null, label: 'Benutzerordner' };
  const name = chat.cwd ? chat.cwd.split('\\').filter(Boolean).pop() : null;
  return { project: null, label: name || 'Unbekannter Ordner' };
}

function dayLabel(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= start) return 'Heute';
  if (ms >= start - 86400_000) return 'Gestern';
  if (ms >= start - 6 * 86400_000) return 'Diese Woche';
  if (d.getFullYear() === today.getFullYear()) return d.toLocaleDateString('de-DE', { month: 'long' });
  return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

interface Props {
  projects: ProjectView[];
  accounts: AccountView[];
  onOpen: (chat: Chat) => void;
  onDragState: (dragging: boolean) => void;
  /** Bumped after a chat was attached, so the list reloads. */
  reload: number;
}

export function ChatsPage({ projects, accounts, onOpen, onDragState, reload }: Props) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [q, setQ] = useState('');
  const [onlyLoose, setOnlyLoose] = useState(false);

  useEffect(() => {
    let live = true;
    api.chats().then((c) => live && setChats(c)).catch(() => live && setChats([]));
    return () => {
      live = false;
    };
  }, [reload, projects.length]);

  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = (chats ?? []).filter((c) => {
      if (onlyLoose && c.projectId) return false;
      const hay = `${c.title} ${chatPlace(c, projects).label}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const out: { label: string; chats: Chat[] }[] = [];
    for (const c of list) {
      const label = dayLabel(c.updatedAt);
      if (out.at(-1)?.label !== label) out.push({ label, chats: [] });
      out.at(-1)!.chats.push(c);
    }
    return out;
  }, [chats, q, onlyLoose, projects]);

  const accountLabel = (dir: string) =>
    accounts.length > 1 ? accounts.find((a) => a.dir.toLowerCase() === dir.toLowerCase())?.label ?? null : null;

  return (
    <main className="pane chats">
      <div className="chats-inner">
        <h1>Chats</h1>
        <p className="chats-lead">Zieh einen Chat auf ein Projekt links, um ihn dort fortzusetzen.</p>

        <div className="chats-bar">
          <div className="field">
            <Search size={18} className="field-icon" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chats durchsuchen" spellCheck={false} autoFocus />
          </div>
          <div className="segmented">
            <Glide selector="button.on" watch={[onlyLoose]} />
            <button className={!onlyLoose ? 'on' : ''} onClick={() => setOnlyLoose(false)}>
              Alle
            </button>
            <button className={onlyLoose ? 'on' : ''} onClick={() => setOnlyLoose(true)}>
              Ohne Projekt
            </button>
          </div>
        </div>

        {chats && groups.length === 0 && (
          <div className="chats-empty">{q ? `Kein Chat passt zu „${q}“.` : 'Alle Chats gehören schon zu einem Projekt.'}</div>
        )}

        {groups.map((g) => (
          <section key={g.label} className="chat-group">
            <h3>{g.label}</h3>
            <div className="chat-grid">
              {g.chats.map((c) => {
                const place = chatPlace(c, projects);
                const acc = accountLabel(c.account);
                return (
                  <button
                    key={`${c.account}|${c.dir}|${c.sessionId}`}
                    className="chat-card"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(CHAT_MIME, JSON.stringify(c));
                      e.dataTransfer.effectAllowed = 'copy';
                      onDragState(true);
                    }}
                    onDragEnd={() => onDragState(false)}
                    onClick={() => onOpen(c)}
                    title={c.cwd ?? undefined}
                  >
                    <span className="chat-title">{c.title}</span>
                    <span className="chat-meta">
                      {place.project ? (
                        <ProjectAvatar project={place.project} size={18} />
                      ) : (
                        <Folder size={14} className="chat-folder" />
                      )}
                      <span className="chat-place">{place.label}</span>
                      {acc && <span className="pill quiet tiny">{acc}</span>}
                      <span className="chat-time">{timeAgo(c.updatedAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
