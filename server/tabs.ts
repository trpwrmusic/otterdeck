import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { WebSocket } from 'ws';
import type { ChatServerMsg, PromptView, TabStatus, TabView, TermServerMsg } from '../shared/types.ts';
import { CLAUDE_BIN, DEFAULT_CLAUDE_DIR, HOME, HOOK_TOKEN, HOST, PORT, SHELL_BIN } from './config.ts';
import { HOOK_SETTINGS, describePermission, describeTool, shorten } from './hooks.ts';
import { encodeProjectDir } from './claudeData.ts';
import { shareMemory } from './memory.ts';
import { TranscriptTail } from './transcript.ts';
import { parsePrompt, promptSummary } from './prompt.ts';
import { data, newId, save, type ProjectRecord, type TabRecord } from './store.ts';

const { Terminal } = headless as unknown as typeof import('@xterm/headless');
const { SerializeAddon } = serialize as unknown as typeof import('@xterm/addon-serialize');

/** Fires "change" whenever something the UI shows has changed. */
export const events = new EventEmitter();
const changed = () => events.emit('change');

// Variables a parent Claude Code session sets (when Otterdeck itself was started from one);
// a claude in our tabs must not inherit them, or it thinks it is a child session.
const STRIP_ENV = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'OTTER_TAB',
  'OTTER_TOKEN',
  'OTTER_URL',
]);

class Tab {
  rec: TabRecord;
  proc: pty.IPty | null = null;
  term: InstanceType<typeof Terminal> | null = null;
  ser: InstanceType<typeof SerializeAddon> | null = null;
  clients = new Set<WebSocket>();
  /** Clients waiting for their snapshot; output is buffered for them meanwhile. */
  pending = new Map<WebSocket, string[]>();

  status: TabStatus = 'dormant';
  title = '';
  activity: string | null = null;
  question: string | null = null;
  /** The dialog on screen right now (permission or question), read from the mirror terminal. */
  prompt: PromptView | null = null;
  private detectTimer: NodeJS.Timeout | null = null;
  lastPrompt: string | null = null;
  lastMessage: string | null = null;
  unseen = false;
  exitCode: number | null = null;
  changedAt = Date.now();
  cols = 120;
  rows = 32;

  constructor(rec: TabRecord) {
    this.rec = rec;
  }

  get project(): ProjectRecord | undefined {
    return data.projects.find((p) => p.id === this.rec.projectId);
  }

  setStatus(s: TabStatus) {
    if (this.status === s) return;
    this.status = s;
    this.changedAt = Date.now();
  }

  view(): TabView {
    return {
      id: this.rec.id,
      projectId: this.rec.projectId,
      kind: this.rec.kind,
      title: this.title || (this.rec.kind === 'claude' ? 'Claude' : 'Shell'),
      status: this.status,
      activity: this.activity,
      question: this.question,
      prompt: this.prompt,
      lastPrompt: this.lastPrompt,
      lastMessage: this.lastMessage,
      unseen: this.unseen,
      claudeSessionId: this.rec.claudeSessionId ?? null,
      account: this.rec.kind === 'claude' ? this.rec.account ?? this.project?.account ?? DEFAULT_CLAUDE_DIR : null,
      exitCode: this.exitCode,
      changedAt: this.changedAt,
    };
  }

  start(opts: { resume?: string; fresh?: boolean; prompt?: string } = {}) {
    if (this.proc) return;
    const project = this.project;
    if (!project) return;
    const cwd = fs.existsSync(project.path) ? project.path : process.env.USERPROFILE || 'C:\\';

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP_ENV.has(k)) env[k] = v;
    env.COLORTERM = 'truecolor';
    env.OTTER_TAB = this.rec.id;
    env.OTTER_TOKEN = HOOK_TOKEN;
    env.OTTER_URL = `http://${HOST}:${PORT}`;

    let file: string;
    let args: string[];
    if (this.rec.kind === 'claude') {
      const account = this.rec.account || project.account || DEFAULT_CLAUDE_DIR;
      this.rec.account = account;
      // The default account (~/.claude) keeps its main file at ~/.claude.json, which Claude only
      // finds when CLAUDE_CONFIG_DIR is unset. Setting it would make Claude look inside the folder
      // and start its first-run setup.
      if (path.resolve(account).toLowerCase() === path.join(HOME, '.claude').toLowerCase()) delete env.CLAUDE_CONFIG_DIR;
      else env.CLAUDE_CONFIG_DIR = account;
      shareMemory(project.path, account);
      args = ['--settings', HOOK_SETTINGS];
      // For tests, e.g. OTTER_CLAUDE_ARGS="--permission-mode default" to see permission prompts.
      if (process.env.OTTER_CLAUDE_ARGS) args.push(...process.env.OTTER_CLAUDE_ARGS.split(/\s+/).filter(Boolean));
      const resume = opts.resume ?? (opts.fresh ? undefined : this.rec.claudeSessionId);
      if (resume) args.push('--resume', resume);
      // A first message (e.g. review comments) starts the conversation right away.
      if (opts.prompt) args.push('--', opts.prompt);
      file = CLAUDE_BIN;
    } else {
      file = SHELL_BIN;
      args = /powershell|pwsh/i.test(file) ? ['-NoLogo'] : [];
    }
    if (/\.(cmd|bat)$/i.test(file)) {
      args = ['/d', '/s', '/c', file, ...args];
      file = process.env.ComSpec || 'cmd.exe';
    }

    this.term?.dispose();
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 5000, allowProposedApi: true });
    this.ser = new SerializeAddon();
    this.term.loadAddon(this.ser as any);
    this.term.onTitleChange((t) => {
      // Claude puts a spinner glyph in front of its title ("✳ Fix login").
      let clean = t.replace(/^[^\p{L}\p{N}]+/u, '').trim();
      // A shell sets its own executable path as the title ("C:\Windows\System32\…\powershell.exe"); that says nothing.
      if (this.rec.kind === 'shell' && /^[a-z]:\\|\.exe$/i.test(clean)) clean = 'Shell';
      if (clean && clean !== this.title) {
        this.title = clean.slice(0, 60);
        changed();
      }
    });

    try {
      this.proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd,
        env,
        useConptyDll: true,
      } as pty.IWindowsPtyForkOptions);
    } catch (err) {
      this.term.write(`\r\n\x1b[31mKonnte ${path.basename(file)} nicht starten: ${(err as Error).message}\x1b[0m\r\n`);
      this.setStatus('exited');
      changed();
      return;
    }

    this.exitCode = null;
    this.activity = this.question = null;
    this.setStatus(this.rec.kind === 'claude' ? 'starting' : 'ready');
    changed();

    // A killed process can still report back after a restart; only listen to the current one.
    const proc = this.proc;
    proc.onData((d) => {
      if (this.proc !== proc) return;
      this.term?.write(d, () => this.scheduleDetect());
      this.broadcast({ t: 'out', d });
    });
    proc.onExit(({ exitCode }) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.exitCode = exitCode;
      this.activity = this.question = null;
      this.setStatus('exited');
      this.broadcast({ t: 'exit', code: exitCode });
      changed();
    });
  }

  broadcast(msg: TermServerMsg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(s);
    if (msg.t === 'out') for (const buf of this.pending.values()) buf.push(s);
  }

  attach(ws: WebSocket, cols: number, rows: number) {
    this.resize(cols, rows);
    if (!this.proc && this.status === 'dormant') this.start();
    this.pending.set(ws, []);
    const send = () => {
      const buf = this.pending.get(ws);
      if (!buf) return;
      this.pending.delete(ws);
      const snap: TermServerMsg = { t: 'snapshot', d: this.ser?.serialize({ scrollback: 5000 }) ?? '' };
      ws.send(JSON.stringify(snap));
      for (const s of buf) ws.send(s);
      if (!this.proc && this.status === 'exited') ws.send(JSON.stringify({ t: 'exit', code: this.exitCode }));
      this.clients.add(ws);
    };
    // Wait until the mirror terminal has parsed everything written so far.
    if (this.term) this.term.write('', send);
    else send();
  }

  detach(ws: WebSocket) {
    this.clients.delete(ws);
    this.pending.delete(ws);
  }

  input(d: string) {
    if (!this.proc) return;
    this.proc.write(d);
    // Esc interrupts Claude; no Stop hook follows an interrupt.
    if (this.rec.kind === 'claude' && d === '\x1b' && (this.status === 'working' || this.status === 'waiting')) {
      this.activity = this.question = null;
      this.setStatus('ready');
      changed();
    }
    touchProject(this.rec.projectId);
  }

  // ---------- chat view ----------

  transcriptPath: string | null = null;
  chatClients = new Set<WebSocket>();
  private chat: TranscriptTail | null = null;
  private chatTimer: NodeJS.Timeout | null = null;

  /** Claude's transcript of this tab's conversation. */
  transcriptFile(): string | null {
    const id = this.rec.claudeSessionId;
    const project = this.project;
    if (!id || !project) return this.transcriptPath;
    const derived = path.join(this.rec.account || project.account || DEFAULT_CLAUDE_DIR, 'projects', encodeProjectDir(project.path), `${id}.jsonl`);
    return this.transcriptPath && path.basename(this.transcriptPath, '.jsonl') === id ? this.transcriptPath : derived;
  }

  private sendChat(ws: WebSocket, msg: ChatServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  attachChat(ws: WebSocket) {
    this.chatClients.add(ws);
    if (!this.chat) this.openChat();
    this.sendChat(ws, { t: 'reset', items: this.chat?.list() ?? [], truncated: !!this.chat?.truncated });
    // A dormant tab starts when you look at it, in either view.
    if (!this.proc && this.status === 'dormant') this.start();
  }

  detachChat(ws: WebSocket) {
    this.chatClients.delete(ws);
    if (!this.chatClients.size) this.closeChat();
  }

  private openChat() {
    const file = this.transcriptFile();
    this.chat = file ? new TranscriptTail(file) : null;
    this.chat?.load();
    this.chatTimer = setInterval(() => {
      if (!this.chat) {
        // The conversation didn't exist yet when the view opened.
        const f = this.transcriptFile();
        if (f && fs.existsSync(f)) this.resetChat();
        return;
      }
      const items = this.chat.poll();
      if (items.length) for (const ws of this.chatClients) this.sendChat(ws, { t: 'upsert', items });
    }, 400);
  }

  private closeChat() {
    if (this.chatTimer) clearInterval(this.chatTimer);
    this.chatTimer = null;
    this.chat = null;
  }

  resetChat() {
    if (!this.chatClients.size) return;
    this.closeChat();
    this.openChat();
    for (const ws of this.chatClients) this.sendChat(ws, { t: 'reset', items: this.chat?.list() ?? [], truncated: !!this.chat?.truncated });
  }

  /**
   * Types a message like keystrokes, so Claude reads it as your own words (a paste would arrive
   * as "pasted content"). Line breaks become Claude Code's "\ + Enter".
   */
  async type(text: string) {
    if (!this.proc) return false;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines[i].length; j += 48) {
        this.proc?.write(lines[i].slice(j, j + 48));
        await new Promise((r) => setTimeout(r, 6));
      }
      if (i < lines.length - 1) {
        this.proc?.write('\\\r');
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    await new Promise((r) => setTimeout(r, 80));
    this.proc?.write('\r');
    touchProject(this.rec.projectId);
    return true;
  }

  /** The visible screen of the mirror terminal as plain lines (what you'd see in the terminal view). */
  screen(): string[] {
    const t = this.term;
    if (!t) return [];
    const buf = t.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < t.rows; i++) out.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '');
    return out;
  }

  /** Looks at the screen shortly after output settles: is a dialog up, or did it just go away? */
  private scheduleDetect() {
    if (this.rec.kind !== 'claude' || this.detectTimer) return;
    this.detectTimer = setTimeout(() => {
      this.detectTimer = null;
      const p = parsePrompt(this.screen());
      if (JSON.stringify(p) === JSON.stringify(this.prompt)) return;
      this.prompt = p;
      if (p) {
        this.question = promptSummary(p);
        this.setStatus('waiting');
      } else if (this.status === 'waiting') {
        this.question = null;
        this.setStatus('working');
      }
      changed();
    }, 120);
  }

  /**
   * Picks option `n` of the dialog on screen by moving the cursor there and pressing Enter.
   * With `text` (the "Type something." option) the answer is typed before Enter.
   */
  async choose(n: number, text?: string) {
    const p = this.prompt;
    if (!p || !this.proc) return false;
    const delta = n - p.selected;
    for (let i = 0; i < Math.abs(delta); i++) {
      this.proc?.write(delta > 0 ? '\x1b[B' : '\x1b[A');
      await new Promise((r) => setTimeout(r, 35));
    }
    await new Promise((r) => setTimeout(r, 60));
    if (text) {
      for (let j = 0; j < text.length; j += 48) {
        this.proc?.write(text.slice(j, j + 48).replace(/\r?\n/g, ' '));
        await new Promise((r) => setTimeout(r, 6));
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    this.proc?.write('\r');
    // "No" hands control back to you; Claude won't report a finished turn for it.
    const label = p.options.find((o) => o.n === n)?.label ?? '';
    if (p.kind === 'permission' && /^no\b/i.test(label)) {
      this.prompt = null;
      this.question = null;
      this.setStatus('ready');
      changed();
    }
    touchProject(this.rec.projectId);
    return true;
  }

  /** Answers Claude's prompts: allow = Enter (first option), deny/stop = Esc. */
  key(name: 'allow' | 'deny' | 'stop') {
    if (!this.proc) return false;
    this.input(name === 'allow' ? '\r' : '\x1b');
    return true;
  }

  /**
   * Sends a message: `lead` is typed like your own words, `text` follows as one paste (so its
   * newlines don't submit early), then Enter. Claude treats pasted text as material, not as your
   * request, which is why the request itself goes in `lead`.
   */
  paste(text: string, submit: boolean, lead = '') {
    if (!this.proc || !text) return false;
    const typed = lead.replace(/[\r\n]+/g, ' ').trim();
    if (typed) this.proc.write(typed + ' ');
    this.proc.write(`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`);
    if (submit) setTimeout(() => this.proc?.write('\r'), 120);
    touchProject(this.rec.projectId);
    return true;
  }

  resize(cols: number, rows: number) {
    cols = Math.max(20, Math.min(500, cols | 0));
    rows = Math.max(5, Math.min(300, rows | 0));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.term?.resize(cols, rows);
    try {
      this.proc?.resize(cols, rows);
    } catch {}
  }

  kill() {
    for (const ws of this.clients) ws.close();
    // Chat windows reconnect and pick up the (same or new) conversation.
    for (const ws of this.chatClients) ws.close();
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
    this.term?.dispose();
    this.term = null;
  }

  hook(event: string, p: any) {
    if (this.rec.kind !== 'claude') return;
    switch (event) {
      case 'SessionStart':
        if (typeof p.transcript_path === 'string') this.transcriptPath = p.transcript_path;
        if (p.session_id && p.session_id !== this.rec.claudeSessionId) {
          // New conversation in this tab (first start, /clear): the chat view follows it.
          this.rec.claudeSessionId = p.session_id;
          save();
          this.resetChat();
        }
        if (this.status === 'starting' || this.status === 'dormant') this.setStatus('ready');
        break;
      case 'UserPromptSubmit':
        this.lastPrompt = shorten(p.prompt, 200);
        this.activity = null;
        this.question = null;
        this.unseen = false;
        this.setStatus('working');
        touchProject(this.rec.projectId);
        break;
      case 'PreToolUse':
        this.activity = describeTool(p.tool_name, p.tool_input);
        this.question = null;
        this.setStatus('working');
        break;
      case 'PostToolUse':
        this.question = null;
        if (this.status === 'waiting') this.setStatus('working');
        break;
      case 'PermissionRequest':
        this.question = describePermission(p.tool_name, p.tool_input);
        this.setStatus('waiting');
        break;
      case 'Notification': {
        const type = String(p.notification_type ?? '');
        const msg = String(p.message ?? '');
        // "Claude is waiting for your input" after a finished turn is not a question.
        if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) break;
        if (type === 'auth_success') break;
        if (!this.question || this.status !== 'waiting') this.question = shorten(msg) ?? 'Braucht deine Antwort';
        this.setStatus('waiting');
        break;
      }
      case 'Stop':
        this.activity = null;
        this.question = null;
        if (p.last_assistant_message) this.lastMessage = shorten(p.last_assistant_message, 240);
        this.unseen = true;
        this.setStatus('done');
        break;
      case 'SessionEnd':
        break;
      default:
        return;
    }
    // A dialog on screen wins over a late hook: Claude is waiting until it's gone.
    if (this.prompt && event !== 'Stop' && event !== 'SessionEnd') {
      this.question = promptSummary(this.prompt);
      this.setStatus('waiting');
    }
    changed();
  }
}

export const tabs = new Map<string, Tab>();

// Tabs from the last run come back dormant and resume their conversation when opened.
for (const rec of data.tabs) if (data.projects.some((p) => p.id === rec.projectId)) tabs.set(rec.id, new Tab(rec));

/** A tab that was asked to carry on after a restart starts right away, without waiting to be opened. */
export function resumePending() {
  for (const tab of tabs.values()) {
    const prompt = tab.rec.pendingPrompt;
    if (!prompt) continue;
    delete tab.rec.pendingPrompt;
    save();
    tab.start({ prompt });
  }
}

export function touchProject(id: string) {
  const p = data.projects.find((x) => x.id === id);
  if (!p) return;
  const now = Date.now();
  if (now - p.lastUsed > 30_000) {
    p.lastUsed = now;
    save();
    changed();
  }
}

/** account: the chat's own account (resuming) or a one-off choice; otherwise the project's default for new chats. */
export function createTab(projectId: string, kind: 'claude' | 'shell', resume?: string, prompt?: string, account?: string) {
  const rec: TabRecord = { id: newId(), projectId, kind, createdAt: Date.now() };
  if (kind === 'claude' && account) rec.account = account;
  if (resume) rec.claudeSessionId = resume;
  data.tabs.push(rec);
  save();
  const tab = new Tab(rec);
  tabs.set(rec.id, tab);
  tab.start({ resume, prompt });
  touchProject(projectId);
  changed();
  return tab;
}

export function closeTab(id: string) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.kill();
  tabs.delete(id);
  data.tabs = data.tabs.filter((t) => t.id !== id);
  save();
  changed();
}

export function restartTab(id: string, fresh = false) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.kill();
  tab.unseen = false;
  tab.start({ fresh });
}

export function markSeen(id: string) {
  const tab = tabs.get(id);
  if (tab?.unseen) {
    tab.unseen = false;
    changed();
  }
}

export function killAll() {
  for (const t of tabs.values()) t.kill();
}

export type { Tab };
