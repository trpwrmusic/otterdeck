import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type * as Pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { WebSocket } from 'ws';
import type { ChatServerMsg, PermissionMode, PromptView, TabStatus, TabView, TermServerMsg } from '../shared/types.ts';
import { claudeBin, CLAUDE_TOKEN_FILE, DEFAULT_CLAUDE_DIR, HOME, HOOK_TOKEN, HOST, IS_WIN, PORT, SERVER_MODE, SHELL_BIN, UPLOAD_DIR } from './config.ts';

/** Claude Code's effort levels Otterdeck offers. */
export const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Puts effortLevel (top level and per model) back to how it was before /effort wrote it. */
function restoreEffortSettings(file: string, before: any) {
  if (!before) return;
  let now: any;
  try {
    now = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const out = { ...now };
  if (before.effortLevel === undefined) delete out.effortLevel;
  else out.effortLevel = before.effortLevel;
  if (now.modelSettings && typeof now.modelSettings === 'object') {
    const ms: any = {};
    for (const [model, cfg] of Object.entries<any>(now.modelSettings)) {
      const prev = before.modelSettings?.[model];
      const next = { ...cfg };
      if (prev?.effortLevel === undefined) delete next.effortLevel;
      else next.effortLevel = prev.effortLevel;
      if (Object.keys(next).length || prev) ms[model] = next;
    }
    if (Object.keys(ms).length || before.modelSettings) out.modelSettings = ms;
    else delete out.modelSettings;
  }
  if (JSON.stringify(out) !== JSON.stringify(now)) fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
}

// node-pty has no Linux build without a compiler; there the prebuilt fork takes over.
const PTY_FALLBACK = '@homebridge/node-pty-prebuilt-multiarch';
const pty: typeof Pty = await import('node-pty')
  .then((m: any) => m.default ?? m)
  .catch(async () => {
    const m: any = await import(PTY_FALLBACK);
    return m.default ?? m;
  });
import { HOOK_SETTINGS, describePermission, describeTool, shorten } from './hooks.ts';
import { AGY_BIN, AgyTranscriptTail, agyBusy, agyModeFlag, agyTranscript, agyModelLabel, agyTitle, describeAgyTool, lastConversationFor, parseAgyMode } from './agy.ts';
import { encodeProjectDir } from './claudeData.ts';
import { shareMemory } from './memory.ts';
import { settings } from './settings.ts';
import { TranscriptTail } from './transcript.ts';
import { parseLogin, parseMode, parsePrompt, parseSetup, promptSummary, readStepCursor, readSuggestion } from './prompt.ts';
import { data, newId, save, type ProjectRecord, type TabRecord } from './store.ts';

const { Terminal } = headless as unknown as typeof import('@xterm/headless');
const { SerializeAddon } = serialize as unknown as typeof import('@xterm/addon-serialize');

/** Fires "change" whenever something the UI shows has changed. */
export const events = new EventEmitter();
const changed = () => events.emit('change');

/**
 * Added to every Claude session in Otterdeck: mails go into a ```mail block, which the chat view
 * shows as a card with copy buttons (copying from the terminal would carry its indentation along).
 */
const CHAT_NOTE = [
  'Diese Sitzung läuft in Otterdeck. Dessen Chat-Ansicht zeigt Codeblöcke mit der Sprache "mail" als E-Mail-Karte mit Kopier-Knöpfen.',
  'Wenn du eine E-Mail oder eine andere Nachricht vorbereitest, die der Nutzer kopieren und selbst abschicken soll (Mail, Antwortentwurf, Chat- oder Kundennachricht),',
  'gib genau diesen Text als Codeblock mit der Sprache mail aus: optional als erste Zeilen "Betreff: …" und "An: …", dann eine Leerzeile, dann der Text ohne Einrückung.',
  'Nichts anderes kommt in diesen Block; Erklärungen davor oder danach als normaler Text.',
].join(' ');

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
  proc: Pty.IPty | null = null;
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
  login: { url: string; code: boolean } | null = null;
  /** Claude Code's suggestion for your next message (dimmed in its input box). */
  suggest: string | null = null;
  mode: PermissionMode | null = null;
  private detectTimer: NodeJS.Timeout | null = null;
  lastPrompt: string | null = null;
  lastMessage: string | null = null;
  unseen = false;
  exitCode: number | null = null;
  changedAt = Date.now();
  cols = 120;
  rows = 32;

  /** Claude Code or Antigravity: an agent with chat view, modes and dialogs (not a shell). */
  get agent() {
    return this.rec.kind === 'claude' || this.rec.kind === 'agy';
  }
  startedAt = 0;
  /** Claude only: how long it thinks. /effort in the running session, --effort on the next start. */
  async setEffort(level: string) {
    if (this.rec.kind !== 'claude' || !EFFORTS.has(level)) return false;
    if (this.status === 'working' || this.status === 'waiting') throw new Error('Erst wenn die Sitzung nicht arbeitet.');
    this.rec.effort = level;
    save();
    if (this.proc) {
      // /effort also saves the level as the account's default for new sessions. Otterdeck changes
      // only this chat, so the account's settings go back to what they were.
      const file = path.join(this.rec.account || this.project?.account || DEFAULT_CLAUDE_DIR, 'settings.json');
      let before: any = null;
      try {
        before = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
      await this.type('/effort ' + level);
      setTimeout(() => restoreEffortSettings(file, before), 2500);
    }
    changed();
    return true;
  }

  /** Model as the CLI shows it (Claude: status line, agy: footer). */
  modelLabel: string | null = null;

  /**
   * Switches the model. Claude takes /model in the running session; agy gets restarted on the same
   * conversation with --model (nothing is lost, the chat continues).
   */
  async setModel(id: string) {
    if (!this.agent) return false;
    if (this.status === 'working' || this.status === 'waiting') throw new Error('Erst wenn die Sitzung nicht arbeitet.');
    this.rec.model = id;
    save();
    if (this.rec.kind === 'claude' && this.proc) {
      await this.type('/model ' + id);
    } else {
      this.kill();
      this.start();
    }
    changed();
    return true;
  }
  /** agy reported through its hooks; until then the screen tells the status. */
  private agyHooks = false;

  /** Antigravity's status from the screen (fallback until hooks arrive) and its conversation id. */
  private detectAgy(screen: string[]) {
    if (!this.rec.claudeSessionId) {
      // No SessionStart hook yet: agy's own "last conversation in this folder", if it is from this tab.
      const id = this.project ? lastConversationFor(this.project.path) : null;
      try {
        if (id && fs.statSync(agyTranscript(id)).mtimeMs >= this.startedAt - 2000) {
          this.rec.claudeSessionId = id;
          save();
          this.resetChat();
        }
      } catch {}
    }
    if (this.status === 'starting' && /\? for shortcuts|esc to cancel/.test(screen.join('\n'))) {
      this.setStatus('ready');
      changed();
    }
    if (this.agyHooks || this.prompt) return;
    const busy = agyBusy(screen);
    if (busy === true && this.status !== 'working') {
      this.setStatus('working');
      changed();
    } else if (busy === false && this.status === 'working') {
      this.unseen = true;
      this.setStatus('done');
      changed();
    }
  }

  /** Hooks from ~/.gemini/config/hooks.json (camelCase payload). */
  private agyHook(event: string, p: any) {
    if (this.rec.kind !== 'agy') return;
    this.agyHooks = true;
    const id = typeof p.conversationId === 'string' ? p.conversationId : null;
    if (id && id !== this.rec.claudeSessionId) {
      this.rec.claudeSessionId = id;
      save();
      this.resetChat();
    }
    switch (event) {
      case 'SessionStart':
        if (this.status === 'starting' || this.status === 'dormant') this.setStatus('ready');
        break;
      case 'PreInvocation':
        if (this.status !== 'working') {
          if (p.lastUserInput) this.lastPrompt = shorten(String(p.lastUserInput).replace(/<[^>]+>/g, ' '), 200);
          this.question = null;
          this.unseen = false;
          this.setStatus('working');
          touchProject(this.rec.projectId);
        }
        break;
      case 'PreToolUse':
        this.activity = describeAgyTool(p.toolCall?.name ?? '', p.toolCall?.args);
        this.question = null;
        if (this.status !== 'waiting') this.setStatus('working');
        break;
      case 'PostToolUse':
        if (this.status === 'waiting' && !this.prompt) this.setStatus('working');
        break;
      case 'Stop': {
        if (p.fullyIdle === false) break;
        const title = this.rec.claudeSessionId ? agyTitle(this.rec.claudeSessionId) : null;
        if (title) this.title = title.slice(0, 60);
        // agy indexes new conversations late; until then your first message names the tab.
        else if (!this.title && this.lastPrompt) this.title = this.lastPrompt.replace(/\s+/g, ' ').slice(0, 40);
        this.activity = null;
        this.question = null;
        this.unseen = true;
        this.setStatus('done');
        break;
      }
      default:
        return;
    }
    if (this.prompt && event !== 'Stop') {
      this.question = promptSummary(this.prompt);
      this.setStatus('waiting');
    }
    changed();
  }

  /** Raw output listeners (e.g. catching the token `claude setup-token` prints). */
  watchers = new Set<(d: string) => void>();

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
      title: this.title || (this.rec.kind === 'claude' ? 'Claude' : this.rec.kind === 'agy' ? 'Antigravity' : 'Shell'),
      status: this.status,
      activity: this.activity,
      question: this.question,
      prompt: this.prompt,
      login: this.login,
      suggestion: this.status === 'done' || this.status === 'ready' ? this.suggest : null,
      mode: this.agent ? this.mode : null,
      model: this.agent ? this.modelLabel : null,
      modelId: this.rec.model ?? null,
      effort: this.rec.kind === 'claude' ? this.rec.effort ?? null : null,
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
      // On the server Claude signs in with the long-lived token instead of a login that expires.
      if (SERVER_MODE && !env.CLAUDE_CONFIG_DIR) {
        try {
          const token = fs.readFileSync(CLAUDE_TOKEN_FILE, 'utf8').trim();
          if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
        } catch {}
      }
      args = ['--settings', HOOK_SETTINGS, '--add-dir', UPLOAD_DIR, '--append-system-prompt', CHAT_NOTE];
      // Extra arguments from the settings; for tests e.g. OTTER_CLAUDE_ARGS="--permission-mode default".
      const extra = settings().claudeArgs;
      if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
      // Our names for the modes (as the footer shows them) → Claude's --permission-mode values.
      const mode = this.rec.mode === 'bypass' ? 'bypassPermissions' : this.rec.mode;
      if (mode && /^(default|acceptEdits|plan|auto|bypassPermissions)$/.test(mode)) args.push('--permission-mode', mode);
      if (this.rec.model) args.push('--model', this.rec.model);
      if (this.rec.effort && EFFORTS.has(this.rec.effort)) args.push('--effort', this.rec.effort);
      const resume = opts.resume ?? (opts.fresh ? undefined : this.rec.claudeSessionId);
      if (resume) args.push('--resume', resume);
      // A first message (e.g. review comments) starts the conversation right away.
      if (opts.prompt) args.push('--', opts.prompt);
      file = claudeBin();
    } else if (this.rec.kind === 'agy') {
      // Antigravity CLI: same terminal, its own flags. It signs in with your Google account (keyring).
      file = AGY_BIN;
      args = ['--add-dir', UPLOAD_DIR];
      const mode = agyModeFlag(this.rec.mode);
      if (mode) args.push('--mode', mode);
      if (this.rec.model) args.push('--model', this.rec.model);
      const resume = opts.resume ?? (opts.fresh ? undefined : this.rec.claudeSessionId);
      if (resume) args.push('--conversation', resume);
      if (opts.prompt) args.push('-i', opts.prompt);
      env.AGY_CLI_DISABLE_AUTO_UPDATE = env.AGY_CLI_DISABLE_AUTO_UPDATE ?? 'false';
    } else if (this.rec.setupToken) {
      // Always the default account (~/.claude): that is the one the server works with.
      delete env.CLAUDE_CONFIG_DIR;
      file = claudeBin();
      args = ['setup-token'];
      this.title = 'Server verbinden';
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
      // agy puts its working folder in the title; the conversation's own title comes from agyTitle().
      if (this.rec.kind === 'agy' && /^([a-z]:\\|~|\/)/i.test(clean)) return;
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
        ...(IS_WIN ? { useConptyDll: true } : {}),
      } as Pty.IWindowsPtyForkOptions);
    } catch (err) {
      this.term.write(`\r\n\x1b[31mKonnte ${path.basename(file)} nicht starten: ${(err as Error).message}\x1b[0m\r\n`);
      this.setStatus('exited');
      changed();
      return;
    }

    this.exitCode = null;
    this.activity = this.question = null;
    this.startedAt = Date.now();
    this.setStatus(this.agent ? 'starting' : 'ready');
    changed();

    // A killed process can still report back after a restart; only listen to the current one.
    const proc = this.proc;
    proc.onData((d) => {
      if (this.proc !== proc) return;
      this.term?.write(d, () => this.scheduleDetect());
      this.broadcast({ t: 'out', d });
      for (const w of this.watchers) w(d);
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
    if (this.agent && d === '\x1b' && (this.status === 'working' || this.status === 'waiting')) {
      this.activity = this.question = null;
      this.setStatus('ready');
      changed();
    }
    // Typing counts as use; the terminal's automatic answers to Claude's queries (escape sequences
    // sent when a tab is merely opened) don't.
    if (!(d.startsWith('\x1b') && d.length > 1)) touchProject(this.rec.projectId);
  }

  // ---------- chat view ----------

  transcriptPath: string | null = null;
  chatClients = new Set<WebSocket>();
  private chat: TranscriptTail | null = null;
  private chatTimer: NodeJS.Timeout | null = null;

  /** Claude's transcript of this tab's conversation. */
  transcriptFile(): string | null {
    if (this.rec.kind === 'agy') return this.rec.claudeSessionId ? agyTranscript(this.rec.claudeSessionId) : null;
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
    this.chat = file ? (this.rec.kind === 'agy' ? new AgyTranscriptTail(file) : new TranscriptTail(file)) : null;
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
    // "!" switches Claude Code into bash mode; it has to arrive on its own, before the command.
    // agy's hooks don't carry your words reliably; remember them for the tab title and the sidebar.
    if (this.rec.kind === 'agy') this.lastPrompt = shorten(text, 200);
    if (text.startsWith('!') && this.rec.kind === 'claude') {
      this.proc.write('!');
      await new Promise((r) => setTimeout(r, 150));
      text = text.slice(1).replace(/^\s+/, '');
      if (!text) return true;
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines[i].length; j += 48) {
        this.proc?.write(lines[i].slice(j, j + 48));
        await new Promise((r) => setTimeout(r, 6));
      }
      if (i < lines.length - 1) {
        this.proc?.write(this.rec.kind === 'agy' ? '\n' : '\\\r');
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

  /**
   * Claude Code's suggestion for your next message: dimmed text in the empty input box, accepted there
   * with Tab/Enter. Text you typed yourself is not dimmed, so it never counts as a suggestion.
   */
  suggestion(): string | null {
    return this.term && this.rec.kind === 'claude' ? readSuggestion(this.term) : null;
  }

  /** Switches the permission mode like Shift+Tab in the terminal, until the footer shows the wanted one. */
  async setMode(target: PermissionMode) {
    if (!this.proc || !this.agent) return false;
    const parse = (s: string[]) => (this.rec.kind === 'agy' ? parseAgyMode(s) : parseMode(s));
    for (let i = 0; i < 6; i++) {
      const now = parse(this.screen()) ?? this.mode;
      if (now === target) {
        this.mode = target;
        changed();
        return true;
      }
      this.proc.write('\x1b[Z'); // Shift+Tab
      // Wait until Claude has redrawn its footer with the next mode, so one press counts once.
      for (let w = 0; w < 20; w++) {
        await new Promise((r) => setTimeout(r, 60));
        const next = parse(this.screen());
        if (next && next !== now) break;
      }
    }
    this.mode = parse(this.screen()) ?? this.mode;
    changed();
    return this.mode === target;
  }

  /** Looks at the screen shortly after output settles: is a dialog up, or did it just go away? */
  private scheduleDetect() {
    if (!this.agent || this.detectTimer) return;
    this.detectTimer = setTimeout(() => {
      this.detectTimer = null;
      const screen = this.screen();
      if (this.rec.kind === 'agy') {
        this.detectAgy(screen);
        const label = agyModelLabel(screen);
        if (label && label !== this.modelLabel) {
          this.modelLabel = label;
          changed();
        }
      }
      const mode = this.rec.kind === 'agy' ? parseAgyMode(screen) : parseMode(screen);
      if (mode && mode !== this.mode) {
        this.mode = mode;
        changed();
      }
      // Its suggestion for your next message (only while it waits for you).
      const sug = this.rec.kind === 'claude' ? this.suggestion() : null;
      if (sug !== this.suggest) {
        this.suggest = sug;
        changed();
      }
      // First start / login: menus without the usual footer, and the sign-in link.
      const claude = this.rec.kind === 'claude';
      // The login menu (first start or /login) reads better as the German sign-in card.
      const p = (claude ? parseSetup(screen) : null) ?? parsePrompt(screen);
      // Several questions: which one is open (its tab is highlighted in the bar).
      if (p?.steps && this.term) p.stepAt = readStepCursor(this.term);
      const login = claude && !p ? parseLogin(screen) : null;
      if (JSON.stringify(p) === JSON.stringify(this.prompt) && JSON.stringify(login) === JSON.stringify(this.login)) return;
      this.prompt = p;
      this.login = login;
      if (login) {
        this.question = 'Anmeldung: Link öffnen und Code einfügen';
        this.setStatus('waiting');
      } else if (p) {
        this.question = promptSummary(p);
        this.setStatus('waiting');
      } else if (this.status === 'waiting') {
        this.question = null;
        this.setStatus('working');
      }
      changed();
    }, 120);
  }

  /** Several questions: opens question `to` (steps.length = the review page) with ←/→ like in the terminal. */
  async goStep(to: number) {
    const p = this.prompt;
    if (!p?.steps || p.stepAt == null || !this.proc) return false;
    const target = Math.max(0, Math.min(p.steps.length, to));
    const delta = target - p.stepAt;
    for (let i = 0; i < Math.abs(delta); i++) {
      this.proc?.write(delta > 0 ? '\x1b[C' : '\x1b[D');
      await new Promise((r) => setTimeout(r, 60));
    }
    return true;
  }

  /** Types the code from the sign-in page into Claude's "Paste code here" field and confirms it. */
  loginCode(code: string) {
    if (!this.proc || !this.login?.code) return false;
    this.proc.write(code);
    setTimeout(() => this.proc?.write('\r'), 150);
    return true;
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
    // "Allow" means the yes option, which is not always the selected one (folder trust: "No, exit").
    const yes = name === 'allow' ? this.prompt?.options.find((o) => /^yes\b/i.test(o.label)) : undefined;
    if (yes) {
      void this.choose(yes.n);
      return true;
    }
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
    if (event.startsWith('agy:')) return this.agyHook(event.slice(4), p);
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
export function createTab(
  projectId: string,
  kind: 'claude' | 'agy' | 'shell',
  resume?: string,
  prompt?: string,
  account?: string,
  extra: Pick<TabRecord, 'mode' | 'setupToken' | 'model' | 'effort'> = {},
) {
  const rec: TabRecord = { id: newId(), projectId, kind, createdAt: Date.now(), ...extra };
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
