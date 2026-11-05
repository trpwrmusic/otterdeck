// Types shared between the Otterdeck server and the web UI.

export type TabKind = 'claude' | 'shell';

/**
 * dormant  – remembered from an earlier run, nothing is running yet (starts when opened)
 * starting – process launched, Claude has not reported its session yet
 * ready    – Claude is idle at its prompt / shell is running
 * working  – Claude is busy with a turn
 * waiting  – Claude needs you (permission prompt or question)
 * done     – Claude finished a turn
 * exited   – the process ended
 */
export type TabStatus = 'dormant' | 'starting' | 'ready' | 'working' | 'waiting' | 'done' | 'exited';

/** A dialog Claude shows in the terminal right now (read from the screen). */
export interface PromptView {
  kind: 'permission' | 'question';
  /** Permission: the tool line ("Bash command"); question: its short header ("Farbe"). */
  title: string | null;
  /** Permission: what it wants to run or change, as shown. */
  detail: string | null;
  question: string;
  options: { n: number; label: string; description: string }[];
  /** The option the cursor is on. */
  selected: number;
  /** Number of the "Type something." option, if the question takes free text. */
  freeText: number | null;
}

export interface TabView {
  id: string;
  projectId: string;
  kind: TabKind;
  title: string;
  status: TabStatus;
  /** What Claude is doing right now, in plain words ("Liest server.ts"). */
  activity: string | null;
  /** What Claude is asking while status is "waiting". */
  question: string | null;
  /** The dialog on screen while waiting, with its options. */
  prompt: PromptView | null;
  /** The prompt that started the current or last turn. */
  lastPrompt: string | null;
  /** Claude's last reply, shortened. */
  lastMessage: string | null;
  /** A finished turn you have not looked at yet. */
  unseen: boolean;
  claudeSessionId: string | null;
  /** Claude config dir this tab runs with (Claude tabs only). */
  account: string | null;
  exitCode: number | null;
  /** When the status last changed (ms). */
  changedAt: number;
}

export interface ProjectView {
  id: string;
  path: string;
  /** Custom name, if set. */
  name: string | null;
  displayName: string;
  pinned: boolean;
  lastUsed: number;
  branch: string | null;
  exists: boolean;
  /** Account new Claude chats in this project start with (null = default account). Existing chats keep their own. */
  account: string | null;
}

export interface AccountView {
  /** Absolute config dir. */
  dir: string;
  label: string;
  email: string | null;
  isDefault: boolean;
}

export interface AppState {
  projects: ProjectView[];
  tabs: TabView[];
  accounts: AccountView[];
  /** Code version the server runs; the window reloads when it changes. */
  version: string;
  /** available: newer code on disk · pending: restart waits for Claude to finish */
  update: { available: boolean; pending: boolean };
}

export interface Suggestion {
  path: string;
  name: string;
  lastUsed: number;
}

export interface Conversation {
  sessionId: string;
  title: string;
  updatedAt: number;
  /** Claude config dir the chat belongs to. */
  account: string;
}

/** A past conversation anywhere on this computer. */
export interface Chat {
  sessionId: string;
  title: string;
  updatedAt: number;
  /** Claude config dir the transcript lives in. */
  account: string;
  /** Claude Code's folder name for it (inside <account>/projects). */
  dir: string;
  /** Folder Claude ran in. */
  cwd: string | null;
  /** Otterdeck project with that folder, if any. */
  projectId: string | null;
}

// ---------- changes panel ----------

/** head = since the last commit · base = everything this branch changed compared to main */
export type CompareMode = 'head' | 'base';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
  added: number;
  removed: number;
  binary: boolean;
}

export interface Changes {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Branch used for mode "base" (e.g. origin/main). */
  base: string | null;
  mode: CompareMode;
  files: ChangedFile[];
  added: number;
  removed: number;
}

export interface DiffLine {
  t: '+' | '-' | ' ';
  text: string;
  old?: number;
  new?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  /** Function or section name git shows after @@. */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  binary: boolean;
  tooLarge: boolean;
  hunks: DiffHunk[];
}

export interface DirEntry {
  name: string;
  dir: boolean;
  /** Usually generated or installed (node_modules, dist …). */
  quiet: boolean;
}

export interface FileContent {
  path: string;
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

// ---------- chat view ----------

export interface ToolResult {
  text: string;
  error: boolean;
  images: number;
}

/** One thing in the chat, built from Claude's transcript. Same id = same thing (updates replace it). */
export type ChatItem =
  | { id: string; k: 'user'; text: string; images: number; at: number }
  | { id: string; k: 'text'; text: string; at: number }
  | { id: string; k: 'thinking'; text: string; at: number }
  | { id: string; k: 'tool'; name: string; summary: string; input: Record<string, unknown>; result: ToolResult | null; at: number }
  | { id: string; k: 'note'; text: string; at: number };

export type ChatServerMsg =
  | { t: 'reset'; items: ChatItem[]; truncated: boolean }
  | { t: 'upsert'; items: ChatItem[] };

/** Messages on /ws/events */
export type EventMsg = { t: 'state'; state: AppState } | { t: 'changes'; projectId: string };

/** Messages on /ws/term */
export type TermClientMsg =
  | { t: 'in'; d: string }
  | { t: 'resize'; cols: number; rows: number };

export type TermServerMsg =
  | { t: 'snapshot'; d: string }
  | { t: 'out'; d: string }
  | { t: 'exit'; code: number | null };
