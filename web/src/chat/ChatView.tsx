import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Brain, CheckCheck, ChevronRight, Clock, Sparkles, FileText, ImageIcon, Plus, Square, SquareTerminal, X } from 'lucide-react';
import type { ChatItem, ChatServerMsg, TabView } from '../../../shared/types';
import { api, chatUrl, usePersisted } from '../api';
import { handleCopyClick, renderMarkdown } from './markdown';
import { ShellCard } from './ShellCard';
import { AgentCard, EditCard, isEdit, StepRow, TodoCard } from './ToolCard';
import { LoginCard, PromptCard } from './PromptCard';
import { formatSize, ModeMenu, type Attachment } from './Composer';
import { ComposerSheet, ModelMenu } from '../ModelPicker';

type Tool = Extract<ChatItem, { k: 'tool' }>;
/** Phone-sized window (same breakpoint as responsive.css). */
function useNarrow() {
  const q = '(max-width: 760px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

type Block =
  | { k: 'item'; item: ChatItem }
  | { k: 'steps'; tools: Tool[] }
  | { k: 'edit'; tool: Tool }
  | { k: 'todo'; tool: Tool }
  | { k: 'agent'; tool: Tool };

/** Groups runs of small steps; edits and the newest task list stand on their own. */
function toBlocks(items: ChatItem[]): Block[] {
  const lastTodo = [...items].reverse().find((i) => i.k === 'tool' && i.name === 'TodoWrite')?.id;
  const out: Block[] = [];
  for (const item of items) {
    if (item.k === 'user' && item.gone) continue; // shown as the normal message it became
    if (item.k === 'tool') {
      if (isEdit(item)) out.push({ k: 'edit', tool: item });
      else if (item.name === 'Agent' || item.name === 'Task') out.push({ k: 'agent', tool: item });
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

/** Your message; attachments Otterdeck listed under "Anhänge:" show as small cards. */
function UserText({ text }: { text: string }) {
  const at = text.lastIndexOf('\n\nAnhänge:\n');
  if (at < 0) return <>{text}</>;
  const words = text.slice(0, at);
  const paths = text
    .slice(at + 11)
    .split('\n')
    .map((l) => l.replace(/^- /, '').trim())
    .filter(Boolean);
  return (
    <>
      {words}
      <span className="bubble-files">
        {paths.map((p) => {
          const name = p.split(/[\\/]/).pop()!.replace(/^[0-9a-f]{12}-/, '');
          const image = /\.(png|jpe?g|gif|webp)$/i.test(p);
          return (
            <span key={p} className="bubble-file" title={p}>
              {image ? <img src={api.uploadUrl(p)} alt="" /> : <FileText size={14} />}
              <span>{name}</span>
            </span>
          );
        })}
      </span>
    </>
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
  // Bash mode like in Claude Code: a "!" typed first turns the box purple and disappears into the
  // prompt sign; Backspace on an empty box or Esc leaves it.
  const [shellMode, setShellMode] = useState(false);
  /** Sent but not yet in the transcript; shown right away. */
  const [pending, setPending] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const [commands, setCommands] = useState<{ name: string; description: string; source: string }[]>([]);
  const [slashSel, setSlashSel] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);

  useEffect(() => {
    // Slash commands are Claude Code's; agy has its own set.
    if (tab.kind === 'claude') api.commands(tab.projectId, tab.id).then(setCommands).catch(() => {});
  }, [tab.projectId, tab.id]);

  // "/" at the start, no space yet: suggest commands and skills.
  const slashQuery = !shellMode && /^\/[^\s]*$/.test(draft) && !slashClosed ? draft.slice(1).toLowerCase() : null;
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
    const sent = new Set(
      items.flatMap((i) => (i.k === 'user' ? [i.text.trim()] : i.k === 'shell' ? ['!' + i.cmd.trim(), '! ' + i.cmd.trim()] : [])),
    );
    const left = pending.filter((p) => !sent.has(p.trim()));
    if (left.length !== pending.length) setPending(left);
  }, [items, pending]);

  // Stay at the bottom while new things arrive, unless you scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, tab.status, tab.question]);

  // Desktop: the chat opens ready to type. Phone/tablet: no focus, or the keyboard pops up every
  // time a chat is opened (touch screens without a mouse).
  useEffect(() => {
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
    input.current?.focus();
  }, [tab.id]);

  // The box grows with what you type (wrapped lines too) and only scrolls past 240px.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    // Empty: one line. (Measuring then would count a wrapped placeholder as content.)
    if (!draft) {
      el.style.height = '';
      el.classList.remove('scroll');
      return;
    }
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, 240);
    el.style.height = `${h}px`;
    el.classList.toggle('scroll', el.scrollHeight > 240);
  }, [draft]);

  const blocks = useMemo(() => toBlocks(items), [items]);
  const lastText = useMemo(() => blocks.reduce((at, b, i) => (b.k === 'item' && b.item.k === 'text' ? i : at), -1), [blocks]);
  // The newest block is a tool: if it has no result yet it spins in the step list already.
  const lastBlock = blocks.at(-1);
  const lastTool = lastBlock?.k === 'steps' ? lastBlock.tools.at(-1) : lastBlock?.k === 'edit' || lastBlock?.k === 'todo' || lastBlock?.k === 'agent' ? lastBlock.tool : null;
  const lastIsTool = !!lastTool;
  const openTool = !!lastTool && !lastTool.result;
  const narrow = useNarrow();
  const running = tab.status === 'working';
  const alive = !['exited', 'dormant'].includes(tab.status);

  // ---------- attachments ----------
  const [files, setFiles] = useState<Attachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const uploading = files.some((f) => f.uploading);

  const addFiles = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setFiles((fs) => [...fs, { key, name: file.name || 'Bild.png', size: file.size, preview, path: null, uploading: true, error: null }]);
      api
        .upload(file)
        .then((r) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, path: r.path, uploading: false } : f))))
        .catch((e) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, uploading: false, error: (e as Error).message } : f))));
    }
    input.current?.focus();
  };

  /** Claude Code's suggestion for your next message, while the box is empty (Tab takes it, Enter sends it). */
  const suggestion = !shellMode && !draft && !files.length && tab.kind === 'claude' ? tab.suggestion : null;

  const send = async (override?: string) => {
    const ready = files.filter((f) => f.path);
    const words = (override ?? draft).trim();
    // A "!" command runs in Claude Code's bash mode; attachments don't belong to it.
    if (shellMode) {
      if (!words) return;
      const cmd = '!' + words;
      setPending((p) => [...p, cmd]);
      setDraft('');
      setShellMode(false);
      stick.current = true;
      try {
        await api.typeToTab(tab.id, cmd);
      } catch {
        setPending((p) => p.filter((x) => x !== cmd));
        setDraft(words);
        setShellMode(true);
      }
      return;
    }
    if ((!words && !ready.length) || uploading) return;
    // Claude reads the attached files itself; the paths go into the message as plain text.
    const text = ready.length
      ? `${words || 'Sieh dir bitte die Anhänge an.'}\n\nAnhänge:\n${ready.map((f) => `- ${f.path}`).join('\n')}`
      : words;
    setPending((p) => [...p, text]);
    setDraft('');
    setFiles([]);
    stick.current = true;
    try {
      await api.typeToTab(tab.id, text);
    } catch {
      setPending((p) => p.filter((x) => x !== text));
      setDraft(words);
      setFiles(ready);
    }
  };

  return (
    <div
      className={`chat${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files') || !alive) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropping(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {dropping && <div className="drop-zone">Zum Anhängen loslassen</div>}
      <div
        className="chat-scroll"
        ref={scroller}
        onClick={(e) => {
          handleCopyClick(e);
          // Touch screens have no hover: tapping an answer shows its copy button.
          const wrap = (e.target as HTMLElement).closest('.msg-claude-wrap');
          if (wrap && !(e.target as HTMLElement).closest('[data-copy], a, button')) {
            for (const w of e.currentTarget.querySelectorAll('.msg-claude-wrap.tapped')) if (w !== wrap) w.classList.remove('tapped');
            wrap.classList.toggle('tapped');
          }
        }}
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
              {b.k === 'agent' && <AgentCard tool={b.tool} running={running} />}
              {b.k === 'item' && b.item.k === 'user' && (
                <div className={`msg-user${b.item.queued ? ' queued ' + b.item.queued : ''}`}>
                  <div className="bubble">
                    <UserText text={b.item.text} />
                    {b.item.images > 0 && (
                      <span className="bubble-img">
                        <ImageIcon size={13} /> {b.item.images === 1 ? 'Bild' : `${b.item.images} Bilder`}
                      </span>
                    )}
                  </div>
                  {b.item.queued && (
                    <div className="queued-note">
                      {b.item.queued === 'waiting' ? (
                        <>
                          <Clock size={12} /> Wartet, Claude liest sie beim nächsten Schritt
                        </>
                      ) : (
                        <>
                          <CheckCheck size={12} /> Während der Arbeit gelesen
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {b.k === 'item' && b.item.k === 'text' && (
                <div className={`msg-claude-wrap${i === lastText ? ' last' : ''}`}>
                  <div className="md msg-claude" dangerouslySetInnerHTML={{ __html: renderMarkdown(b.item.text) }} />
                  <button className="copy-btn msg-copy" data-copy={encodeURIComponent(b.item.text)} title="Antwort kopieren">
                    Kopieren
                  </button>
                </div>
              )}
              {b.k === 'item' && b.item.k === 'thinking' && <Thinking text={b.item.text} />}
              {b.k === 'item' && b.item.k === 'note' && <div className="chat-note">{b.item.text}</div>}
              {b.k === 'item' && b.item.k === 'shell' && <ShellCard cmd={b.item.cmd} out={b.item.out} err={b.item.err} />}
            </Fragment>
          ))}
          {pending.map((p, i) =>
            p.startsWith('!') ? (
              <ShellCard key={`p${i}`} cmd={p.slice(1).trim()} out={null} err="" />
            ) : (
              <div className="msg-user pending" key={`p${i}`}>
                <div className="bubble">
                  <UserText text={p} />
                </div>
              </div>
            ),
          )}
          {running && !openTool && (
            <div className="chat-status">
              <span className="mark working" style={{ width: 14, height: 14 }} />
              {/* The step list already names the tool; don't repeat a finished one here. */}
              {lastIsTool || !tab.activity ? 'Denkt nach …' : tab.activity}
            </div>
          )}
          {tab.status === 'waiting' &&
            (tab.login ? (
              <LoginCard tab={tab} login={tab.login} onShowTerminal={onShowTerminal} />
            ) : tab.prompt ? (
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
        <div className={`composer${shellMode ? ' shell-mode' : ''}`}>
          {files.length > 0 && (
            <div className="attachments">
              {files.map((f) => (
                <div key={f.key} className={`attachment${f.error ? ' error' : ''}${f.uploading ? ' uploading' : ''}`} title={f.error ?? f.path ?? f.name}>
                  {f.preview ? <img src={f.preview} alt="" /> : <FileText size={18} />}
                  <span className="att-text">
                    <span className="att-name">{f.name}</span>
                    <span className="att-meta">{f.error ? 'Fehler' : f.uploading ? 'Lädt …' : formatSize(f.size)}</span>
                  </span>
                  <button className="att-remove" onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))} aria-label="Entfernen">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {suggestion && narrow && (
            <button className="suggest-chip" onClick={() => setDraft(suggestion)} title="Vorschlag von Claude übernehmen">
              <Sparkles size={13} />
              <span>{suggestion}</span>
            </button>
          )}
          <div className="composer-row">
          {shellMode ? (
            <span className="shell-bang" title="Shell-Befehl: läuft direkt, Claude liest die Ausgabe mit">
              !
            </span>
          ) : (
            <button className="round-btn plain" onClick={() => picker.current?.click()} disabled={!alive} title="Dateien oder Bilder hinzufügen">
              <Plus size={18} />
            </button>
          )}
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <textarea
            ref={input}
            value={draft}
            rows={1}
            placeholder={
              !alive
                ? 'Claude läuft gerade nicht'
                : suggestion && !narrow
                  ? suggestion + '   ⇥ Tab übernimmt, Enter sendet'
                : shellMode
                  ? narrow ? 'Shell-Befehl' : 'Shell-Befehl · Claude liest die Ausgabe mit'
                  : narrow ? (tab.kind === 'agy' ? 'Nachricht' : 'Nachricht an Claude') : tab.kind === 'agy' ? 'Nachricht an Antigravity' : 'Nachricht an Claude · ! für einen Shell-Befehl'
            }
            disabled={!alive}
            onChange={(e) => {
              const v = e.target.value;
              // Bash mode ("!") is a Claude Code feature; agy sends "!" as text.
              if (!shellMode && !draft && v.startsWith('!') && tab.kind === 'claude') {
                setShellMode(true);
                setDraft(v.slice(1).replace(/^\s+/, ''));
              } else setDraft(v);
            }}
            onPaste={(e) => {
              // A screenshot or copied file in the clipboard becomes an attachment.
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (shellMode && ((e.key === 'Backspace' && !draft) || e.key === 'Escape')) {
                e.preventDefault();
                setShellMode(false);
                return;
              }
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
              // Claude Code's suggestion: Tab puts it into the box, Enter on the empty box sends it.
              if (suggestion && e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                setDraft(suggestion);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(suggestion && !draft.trim() ? suggestion : undefined);
              }
            }}
          />
          {narrow ? (
            <ComposerSheet tab={tab} />
          ) : (
            <>
              <ModelMenu tab={tab} />
              <ModeMenu tab={tab} />
            </>
          )}
          {running ? (
            <button className="round-btn" onClick={() => api.keyToTab(tab.id, 'stop')} title="Anhalten (Esc)">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              className="round-btn primary"
              onClick={() => send()}
              disabled={(!draft.trim() && !files.some((f) => f.path)) || uploading || !alive}
              title="Senden (Enter)"
            >
              <ArrowUp size={17} strokeWidth={2.6} />
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
