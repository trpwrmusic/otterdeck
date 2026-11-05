import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Brain, ChevronRight, ImageIcon, Square, SquareTerminal } from 'lucide-react';
import type { ChatItem, ChatServerMsg, TabView } from '../../../shared/types';
import { api, chatUrl, usePersisted } from '../api';
import { renderMarkdown } from './markdown';
import { EditCard, isEdit, StepRow, TodoCard } from './ToolCard';
import { PromptCard } from './PromptCard';

type Tool = Extract<ChatItem, { k: 'tool' }>;
type Block =
  | { k: 'item'; item: ChatItem }
  | { k: 'steps'; tools: Tool[] }
  | { k: 'edit'; tool: Tool }
  | { k: 'todo'; tool: Tool };

/** Groups runs of small steps; edits and the newest task list stand on their own. */
function toBlocks(items: ChatItem[]): Block[] {
  const lastTodo = [...items].reverse().find((i) => i.k === 'tool' && i.name === 'TodoWrite')?.id;
  const out: Block[] = [];
  for (const item of items) {
    if (item.k === 'tool') {
      if (isEdit(item)) out.push({ k: 'edit', tool: item });
      else if (item.name === 'TodoWrite') {
        if (item.id === lastTodo) out.push({ k: 'todo', tool: item });
      } else {
        const last = out.at(-1);
        if (last?.k === 'steps') last.tools.push(item);
        else out.push({ k: 'steps', tools: [item] });
      }
    } else out.push({ k: 'item', item });
  }
  return out;
}

function Steps({ tools, running }: { tools: Tool[]; running: boolean }) {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, tools.length - 3);
  return (
    <div className="steps">
      {hidden > 0 && (
        <button className="steps-more" onClick={() => setAll(true)}>
          {hidden === 1 ? '1 weiterer Schritt' : `${hidden} weitere Schritte`}
        </button>
      )}
      {tools.slice(hidden).map((t) => (
        <StepRow key={t.id} tool={t} running={running} />
      ))}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking${open ? ' open' : ''}`}>
      <button onClick={() => setOpen(!open)}>
        <Brain size={14} /> Gedanken <ChevronRight size={13} className={`chev${open ? ' rot' : ''}`} />
      </button>
      {open && <div className="md quiet" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
    </div>
  );
}

interface Props {
  tab: TabView;
  onShowTerminal: () => void;
}

export function ChatView({ tab, onShowTerminal }: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = usePersisted(`otter.draft.${tab.id}`, '');
  /** Sent but not yet in the transcript; shown right away. */
  const [pending, setPending] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const [commands, setCommands] = useState<{ name: string; description: string; source: string }[]>([]);
  const [slashSel, setSlashSel] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);

  useEffect(() => {
    api.commands(tab.projectId, tab.id).then(setCommands).catch(() => {});
  }, [tab.projectId, tab.id]);

  // "/" at the start, no space yet: suggest commands and skills.
  const slashQuery = /^\/[^\s]*$/.test(draft) && !slashClosed ? draft.slice(1).toLowerCase() : null;
  const slashList = useMemo(() => {
    if (slashQuery === null) return [];
    const starts = commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery));
    const contains = commands.filter((c) => !c.name.toLowerCase().startsWith(slashQuery) && c.name.toLowerCase().includes(slashQuery));
    return [...starts, ...contains].slice(0, 8);
  }, [commands, slashQuery]);
  useEffect(() => setSlashSel(0), [slashQuery]);
  useEffect(() => {
    if (!draft.startsWith('/')) setSlashClosed(false);
  }, [draft]);
  const pickSlash = (name: string) => {
    setDraft(`/${name} `);
    input.current?.focus();
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: number | undefined;
    const map = new Map<string, ChatItem>();
    let order: string[] = [];
    const connect = () => {
      ws = new WebSocket(chatUrl(tab.id));
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ChatServerMsg;
        if (msg.t === 'reset') {
          map.clear();
          order = [];
          setTruncated(msg.truncated);
        }
        for (const it of msg.items) {
          if (!map.has(it.id)) order.push(it.id);
          map.set(it.id, it);
        }
        setItems(order.map((id) => map.get(id)!));
        setLoaded(true);
      };
      ws.onclose = (e) => {
        if (closed || e.code === 4404) return;
        retry = window.setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [tab.id]);

  // Drop optimistic messages once Claude's transcript has them.
  useEffect(() => {
    if (!pending.length) return;
    const sent = new Set(items.filter((i) => i.k === 'user').map((i) => (i as any).text.trim()));
    const left = pending.filter((p) => !sent.has(p.trim()));
    if (left.length !== pending.length) setPending(left);
  }, [items, pending]);

  // Stay at the bottom while new things arrive, unless you scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, tab.status, tab.question]);

  useEffect(() => input.current?.focus(), [tab.id]);

  // The box grows with what you type (wrapped lines too) and only scrolls past 240px.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, 240);
    el.style.height = `${h}px`;
    el.classList.toggle('scroll', el.scrollHeight > 240);
  }, [draft]);

  const blocks = useMemo(() => toBlocks(items), [items]);
  const running = tab.status === 'working';
  const alive = !['exited', 'dormant'].includes(tab.status);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setPending((p) => [...p, text]);
    setDraft('');
    stick.current = true;
    try {
      await api.typeToTab(tab.id, text);
    } catch {
      setPending((p) => p.filter((x) => x !== text));
      setDraft(text);
    }
  };

  return (
    <div className="chat">
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="chat-inner">
          {truncated && <div className="chat-note">Frühere Teile dieses Gesprächs stehen im Terminal.</div>}
          {loaded && !items.length && !pending.length && (
            <div className="chat-empty">{tab.status === 'starting' ? 'Claude startet …' : 'Schreib Claude, was zu tun ist.'}</div>
          )}
          {blocks.map((b, i) => (
            <Fragment key={b.k === 'item' ? b.item.id : b.k === 'steps' ? b.tools[0].id : b.tool.id}>
              {b.k === 'steps' && <Steps tools={b.tools} running={running && i === blocks.length - 1} />}
              {b.k === 'edit' && <EditCard tool={b.tool} />}
              {b.k === 'todo' && <TodoCard tool={b.tool} />}
              {b.k === 'item' && b.item.k === 'user' && (
                <div className="msg-user">
                  <div className="bubble">
                    {b.item.text}
                    {b.item.images > 0 && (
                      <span className="bubble-img">
                        <ImageIcon size={13} /> {b.item.images === 1 ? 'Bild' : `${b.item.images} Bilder`}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {b.k === 'item' && b.item.k === 'text' && <div className="md msg-claude" dangerouslySetInnerHTML={{ __html: renderMarkdown(b.item.text) }} />}
              {b.k === 'item' && b.item.k === 'thinking' && <Thinking text={b.item.text} />}
              {b.k === 'item' && b.item.k === 'note' && <div className="chat-note">{b.item.text}</div>}
            </Fragment>
          ))}
          {pending.map((p, i) => (
            <div className="msg-user pending" key={`p${i}`}>
              <div className="bubble">{p}</div>
            </div>
          ))}
          {running && (
            <div className="chat-status">
              <span className="mark working" style={{ width: 14, height: 14 }} />
              {tab.activity ?? 'Arbeitet …'}
            </div>
          )}
          {tab.status === 'waiting' &&
            (tab.prompt ? (
              <PromptCard key={tab.prompt.question + tab.prompt.title} tab={tab} prompt={tab.prompt} onShowTerminal={onShowTerminal} />
            ) : (
              <div className="ask-card">
                <div className="ask-q">{tab.question ?? 'Claude braucht deine Antwort.'}</div>
                <div className="ask-actions">
                  <button className="btn quiet" onClick={onShowTerminal}>
                    <SquareTerminal size={15} /> Im Terminal antworten
                  </button>
                </div>
              </div>
            ))}
        </div>
      </div>

      <div className="composer-wrap">
        {slashList.length > 0 && (
          <div className="slash" role="listbox">
            {slashList.map((c, i) => (
              <button
                key={c.name}
                className={`slash-item${i === slashSel ? ' sel' : ''}`}
                onMouseMove={() => setSlashSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(c.name);
                }}
              >
                <span className="slash-name">/{c.name}</span>
                <span className="slash-desc">{c.description}</span>
                <span className="slash-src">{c.source}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <textarea
            ref={input}
            value={draft}
            rows={1}
            placeholder={alive ? 'Nachricht an Claude' : 'Claude läuft gerade nicht'}
            disabled={!alive}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (slashList.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashSel((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + slashList.length) % slashList.length);
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && slashList[slashSel]?.name.toLowerCase() !== slashQuery)) {
                  e.preventDefault();
                  pickSlash(slashList[slashSel].name);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSlashClosed(true);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          {running ? (
            <button className="round-btn" onClick={() => api.keyToTab(tab.id, 'stop')} title="Anhalten (Esc)">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button className="round-btn primary" onClick={send} disabled={!draft.trim() || !alive} title="Senden (Enter)">
              <ArrowUp size={17} strokeWidth={2.6} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
