// Reads what Claude Code itself keeps on disk: accounts, past conversations, folders you used it in.
import fs from 'node:fs';
import path from 'node:path';
import type { AccountView, Chat, Conversation, Suggestion } from '../shared/types.ts';
import { DEFAULT_CLAUDE_DIR, HOME } from './config.ts';

/** Claude Code's folder name for a project path: every non-alphanumeric char becomes "-". */
export const encodeProjectDir = (p: string) => path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');

function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file: string, bytes: number): string {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function lines(text: string): any[] {
  const out: any[] = [];
  for (const l of text.split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

// ---------- accounts ----------

function accountEmail(dir: string): string | null {
  // The default account keeps its sign-in in ~/.claude.json, others inside their own folder.
  const candidates = path.resolve(dir) === path.join(HOME, '.claude')
    ? [path.join(HOME, '.claude.json'), path.join(dir, '.claude.json')]
    : [path.join(dir, '.claude.json')];
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.oauthAccount?.emailAddress) return j.oauthAccount.emailAddress;
    } catch {}
  }
  return null;
}

export function listAccounts(): AccountView[] {
  const dirs = new Set<string>([path.resolve(DEFAULT_CLAUDE_DIR)]);
  for (const e of fs.readdirSync(HOME, { withFileTypes: true })) {
    if (e.isDirectory() && /^\.claude(-.+)?$/.test(e.name)) {
      const dir = path.join(HOME, e.name);
      if (fs.existsSync(path.join(dir, 'projects')) || fs.existsSync(path.join(dir, '.claude.json'))) dirs.add(dir);
    }
  }
  return [...dirs].map((dir) => {
    const name = path.basename(dir);
    const label = name === '.claude' ? 'Standard' : name.replace(/^\.claude-/, '');
    return {
      dir,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      email: accountEmail(dir),
      isDefault: path.resolve(dir) === path.resolve(DEFAULT_CLAUDE_DIR),
    };
  });
}

// ---------- folders you used Claude in ----------

function cwdOf(file: string): string | null {
  for (const j of lines(readHead(file, 64 * 1024))) if (typeof j.cwd === 'string') return j.cwd;
  return null;
}

export function suggestions(known: string[]): Suggestion[] {
  const seen = new Map<string, Suggestion>();
  const knownSet = new Set(known.map((p) => path.resolve(p).toLowerCase()));
  for (const acc of listAccounts()) {
    const root = path.join(acc.dir, 'projects');
    let dirs: fs.Dirent[] = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const files = jsonlFiles(path.join(root, d.name));
      if (!files.length) continue;
      const cwd = cwdOf(files[0].file);
      if (!cwd) continue;
      const key = path.resolve(cwd).toLowerCase();
      if (knownSet.has(key) || !fs.existsSync(cwd)) continue;
      // Skip temp folders and the bare home folder.
      if (/\\(temp|tmp)\\/i.test(cwd + '\\') || key === HOME.toLowerCase()) continue;
      const prev = seen.get(key);
      if (!prev || prev.lastUsed < files[0].mtime)
        seen.set(key, { path: cwd, name: path.basename(cwd), lastUsed: files[0].mtime });
    }
  }
  return [...seen.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 12);
}

function jsonlFiles(dir: string) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = path.join(dir, f);
        return { file, id: f.slice(0, -6), mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// ---------- past conversations ----------

interface ChatInfo {
  title: string | null;
  cwd: string | null;
  /** "cli" for interactive sessions, "sdk-cli" for `claude -p` and tools. */
  entrypoint: string | null;
  /** Time of the last real message (yours or Claude's); compaction, resumes and bookkeeping don't count. */
  lastAt: number | null;
}

/** A line that is an actual exchange, not machinery Claude writes on its own. */
function isMessage(j: any): boolean {
  if (j.type !== 'user' && j.type !== 'assistant') return false;
  if (j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) return false;
  const c = j.message?.content;
  if (j.type === 'user' && typeof c === 'string' && /^s*<(command-name|local-command-stdout|local-command-caveat|system-reminder)/.test(c)) return false;
  return typeof j.timestamp === 'string';
}

function lastMessageAt(entries: any[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) if (isMessage(entries[i])) return Date.parse(entries[i].timestamp) || null;
  return null;
}

const infoCache = new Map<string, { mtime: number; info: ChatInfo }>();

function chatInfo(file: string, mtime: number): ChatInfo {
  const hit = infoCache.get(file);
  if (hit && hit.mtime === mtime) return hit.info;
  const head = lines(readHead(file, 96 * 1024));
  const tail = lines(readTail(file, 96 * 1024));
  const titled = [...head, ...tail].filter((j) => j.type === 'ai-title' || j.type === 'custom-title');
  const custom = titled.filter((j) => j.type === 'custom-title').pop();
  const raw = custom?.customTitle ?? titled.pop()?.aiTitle ?? firstPrompt(head);
  const info: ChatInfo = {
    title: raw ? String(raw).replace(/\s+/g, ' ').trim().slice(0, 120) : null,
    cwd: head.find((j) => typeof j.cwd === 'string')?.cwd ?? null,
    entrypoint: head.find((j) => typeof j.entrypoint === 'string')?.entrypoint ?? null,
    lastAt: lastMessageAt(tail) ?? lastMessageAt(head),
  };
  infoCache.set(file, { mtime, info });
  return info;
}

/** Chats worth listing: has a title, was interactive, didn't run in a temp folder. */
const listable = (i: ChatInfo) => !!i.title && i.entrypoint !== 'sdk-cli' && !/\\(temp|tmp)\\/i.test((i.cwd ?? '') + '\\');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIR_NAME = /^[A-Za-z0-9-]+$/;

/** Recent chats across all accounts and folders, newest first. */
export function allChats(projects: { id: string; path: string }[], limit = 200): Chat[] {
  const files: { file: string; mtime: number; account: string; dir: string; id: string }[] = [];
  for (const acc of listAccounts()) {
    const root = path.join(acc.dir, 'projects');
    let dirs: fs.Dirent[] = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      for (const f of jsonlFiles(path.join(root, d.name)))
        files.push({ file: f.file, mtime: f.mtime, account: acc.dir, dir: d.name, id: f.id });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const byPath = new Map(projects.map((p) => [path.resolve(p.path).toLowerCase(), p.id]));
  // Where a transcript is stored decides its project (a chat dragged onto a project is a copy there).
  const byDir = new Map(projects.map((p) => [encodeProjectDir(p.path).toLowerCase(), p.id]));
  const out: Chat[] = [];
  const seen = new Map<string, number>(); // sessionId → index in out
  for (const f of files) {
    if (out.length >= limit) break;
    if (!SESSION_ID.test(f.id)) continue;
    const dirProject = byDir.get(f.dir.toLowerCase()) ?? null;
    const prev = seen.get(f.id);
    // The same chat in several places: show it once, preferring the copy that belongs to a project.
    if (prev !== undefined && (out[prev].projectId || !dirProject)) continue;
    let info: ChatInfo;
    try {
      info = chatInfo(f.file, f.mtime);
    } catch {
      continue;
    }
    if (!listable(info)) continue;
    const chat: Chat = {
      sessionId: f.id,
      title: info.title!,
      updatedAt: info.lastAt ?? f.mtime,
      account: f.account,
      dir: f.dir,
      cwd: info.cwd,
      projectId: dirProject ?? (info.cwd ? byPath.get(path.resolve(info.cwd).toLowerCase()) ?? null : null),
    };
    if (prev !== undefined) out[prev] = { ...chat, updatedAt: Math.max(chat.updatedAt, out[prev].updatedAt) };
    else {
      seen.set(f.id, out.length);
      out.push(chat);
    }
  }
  return out;
}

/**
 * Makes a chat resumable in a project by copying its transcript into the project's folder
 * (Claude's --resume only looks there). The copy stays in the chat's own account, because the
 * account belongs to the chat, not to the project. The original stays where it is.
 */
export function attachChat(src: { account: string; dir: string; sessionId: string }, projectPath: string) {
  if (!SESSION_ID.test(src.sessionId) || !DIR_NAME.test(src.dir)) throw new Error('Ungültiger Chat.');
  if (!listAccounts().some((a) => path.resolve(a.dir) === path.resolve(src.account))) throw new Error('Unbekanntes Konto.');
  const fromDir = path.join(src.account, 'projects', src.dir);
  const from = path.join(fromDir, `${src.sessionId}.jsonl`);
  if (!fs.existsSync(from)) throw new Error('Diesen Chat gibt es nicht mehr.');
  const toDir = path.join(src.account, 'projects', encodeProjectDir(projectPath));
  const to = path.join(toDir, `${src.sessionId}.jsonl`);
  if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase() || fs.existsSync(to)) return { copied: false };
  fs.mkdirSync(toDir, { recursive: true });
  fs.copyFileSync(from, to);
  // Keep the original's date: a copy is not a new chat.
  const st = fs.statSync(from);
  fs.utimesSync(to, st.atime, st.mtime);
  // Subagent transcripts and tool results live in a folder named after the session.
  const extra = path.join(fromDir, src.sessionId);
  if (fs.existsSync(extra)) fs.cpSync(extra, path.join(toDir, src.sessionId), { recursive: true });
  return { copied: true };
}

function firstPrompt(entries: any[]): string | null {
  for (const j of entries) {
    if (j.type !== 'user' || j.isSidechain || j.isMeta) continue;
    const c = j.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x: any) => x.type === 'text')?.text : null;
    if (typeof text === 'string' && text.trim() && !text.trimStart().startsWith('<')) return text.trim();
  }
  return null;
}

/** A project's chats from every account, newest first; each one resumes with its own account. */
export function conversations(projectPath: string, limit = 9): Conversation[] {
  const enc = encodeProjectDir(projectPath);
  const files = listAccounts()
    .flatMap((a) => jsonlFiles(path.join(a.dir, 'projects', enc)).map((f) => ({ ...f, account: a.dir })))
    .sort((a, b) => b.mtime - a.mtime);
  const out: Conversation[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (out.length >= limit) break;
    if (seen.has(f.id)) continue;
    try {
      const info = chatInfo(f.file, f.mtime);
      if (!info.title || info.entrypoint === 'sdk-cli') continue;
      seen.add(f.id);
      out.push({ sessionId: f.id, title: info.title, updatedAt: info.lastAt ?? f.mtime, account: f.account });
    } catch {}
  }
  return out;
}

// ---------- slash commands for the chat box ----------

export interface SlashCommand {
  name: string;
  description: string;
  source: 'eingebaut' | 'Skill' | 'Projekt' | 'Eigener Befehl';
}

const BUILT_IN: [string, string][] = [
  ['clear', 'Neues Gespräch beginnen'],
  ['compact', 'Gespräch verdichten, um Platz zu schaffen'],
  ['model', 'Modell wechseln'],
  ['resume', 'Früheres Gespräch fortsetzen'],
  ['context', 'Zeigen, wie voll der Kontext ist'],
  ['usage', 'Verbrauch und Limits des Plans'],
  ['memory', 'Erinnerungen und CLAUDE.md bearbeiten'],
  ['review', 'Änderungen prüfen lassen'],
  ['init', 'CLAUDE.md für dieses Projekt anlegen'],
  ['agents', 'Agenten verwalten'],
  ['mcp', 'MCP-Server verwalten'],
  ['permissions', 'Berechtigungen ansehen und ändern'],
  ['rewind', 'Zu einem früheren Stand zurückspringen'],
  ['export', 'Gespräch exportieren'],
  ['config', 'Einstellungen öffnen'],
  ['help', 'Hilfe zu Claude Code'],
];

function frontmatterDescription(file: string): string {
  try {
    const text = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const body = fm ? fm[1] : '';
    const m = body.match(/^description:\s*(?:>-?|\|-?)?\s*\r?\n?([\s\S]*?)(?:\r?\n[a-z_-]+:|$)/im);
    const d = (m?.[1] ?? '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
    if (d) return d.length > 110 ? d.slice(0, 109) + '…' : d;
    const first = text.replace(/^---[\s\S]*?---/, '').split('\n').find((l) => l.trim() && !l.startsWith('#'));
    return (first ?? '').trim().slice(0, 110);
  } catch {
    return '';
  }
}

function listCommands(dir: string, source: SlashCommand['source']): SlashCommand[] {
  const out: SlashCommand[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) out.push({ name: e.name.slice(0, -3), description: frontmatterDescription(path.join(dir, e.name)), source });
    }
  } catch {}
  return out;
}

function listSkills(dir: string, source: SlashCommand['source']): SlashCommand[] {
  const out: SlashCommand[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name, 'SKILL.md');
      if (e.isDirectory() && fs.existsSync(file)) out.push({ name: e.name, description: frontmatterDescription(file), source });
    }
  } catch {}
  return out;
}

/** Everything you can type after "/" in a project: Claude's own commands, your skills and commands, the project's. */
export function slashCommands(projectPath: string, accountDir: string): SlashCommand[] {
  const all = [
    ...listCommands(path.join(projectPath, '.claude', 'commands'), 'Projekt'),
    ...listSkills(path.join(projectPath, '.claude', 'skills'), 'Projekt'),
    ...listCommands(path.join(accountDir, 'commands'), 'Eigener Befehl'),
    ...listSkills(path.join(accountDir, 'skills'), 'Skill'),
    ...BUILT_IN.map(([name, description]) => ({ name, description, source: 'eingebaut' as const })),
  ];
  const seen = new Set<string>();
  return all.filter((c) => !seen.has(c.name) && seen.add(c.name));
}

/** When a chat in this folder last changed (newest transcript, any account), or null. */
export function lastChatAt(projectPath: string): number | null {
  const enc = encodeProjectDir(projectPath);
  let newest: number | null = null;
  for (const a of listAccounts()) {
    // A few most recently written files: a resume or a compaction can touch an old chat last.
    for (const f of jsonlFiles(path.join(a.dir, 'projects', enc)).slice(0, 4)) {
      if (newest !== null && f.mtime <= newest) break; // nothing in it can be newer than the file itself
      let at: number | null = null;
      try {
        const info = chatInfo(f.file, f.mtime);
        if (info.entrypoint !== 'sdk-cli') at = info.lastAt;
      } catch {}
      if (at !== null && (newest === null || at > newest)) newest = at;
    }
  }
  return newest;
}
