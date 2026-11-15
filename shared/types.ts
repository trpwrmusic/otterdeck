// Types shared between the Otterdeck server and the web UI.

/** An AI provider Otterdeck can run: Claude Code or the Antigravity CLI. */
export type Provider = 'claude' | 'agy';

/** A model to pick for a new chat or to switch to in a running one. */
export interface ModelChoice {
  provider: Provider;
  /** What goes to --model / /model. */
  id: string;
  label: string;
  hint?: string;
}

/** claude = Claude Code, agy = Antigravity CLI (Google), shell = PowerShell/bash. */
export type TabKind = 'claude' | 'agy' | 'shell';

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

/** default = asks before acting · acceptEdits = edits allowed · plan = plans only · auto = decides itself · bypass = never asks */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypass';

/** A dialog Claude shows in the terminal right now (read from the screen). */
export interface PromptView {
  kind: 'permission' | 'question';
  /** Permission: the tool line ("Bash command"); question: its short header ("Farbe"). */
  title: string | null;
  /** Permission: what it wants to run or change, as shown. */
  detail: string | null;
  question: string;
  /**
   * n = position in the list (the cursor moves through them in this order). checked: multiple choice
   * box state. action: the unnumbered "Submit" under a multiple-choice list (goes on).
   */
  options: { n: number; label: string; description: string; checked?: boolean; action?: boolean }[];
  /** The option the cursor is on. */
  selected: number;
  /** Number of the "Type something." option, if the question takes free text. */
  freeText: number | null;
  /** Several options can be ticked (Enter ticks, "Submit" goes on). */
  multi?: boolean;
  /** Several questions in a row: their short headers, answered ones done. */
  steps?: { label: string; done: boolean }[];
  /** The last page of several questions: what you answered, before it is sent. */
  review?: { question: string; answer: string }[];
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
  /** Claude Code shows its sign-in link (login with a subscription): open it, paste the code back. */
  login: { url: string; code: boolean } | null;
  /** Claude Code's suggestion for your next message (Tab takes it), null when there is none. */
  suggestion: string | null;
  /** Claude Code's permission mode as its footer shows it (null = not seen yet). */
  mode: PermissionMode | null;
  /** Model the session runs with, as the CLI shows it (e.g. "Opus 5.5", "Gemini 4 Argon (Medium)"). */
  model: string | null;
  /** Model id it was started with or switched to (null = the CLI's default). */
  modelId: string | null;
  /** Claude's thinking effort set from Otterdeck (null = the account's setting). */
  effort: string | null;
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
  /** Newest chat transcript in this project, any account (ms), or null without chats. */
  lastChat: number | null;
  branch: string | null;
  exists: boolean;
  /** Group it belongs to, e.g. "Heidehof" for the app and the website (null = on its own). */
  group: string | null;
  /** Account new Claude chats in this project start with (null = default account). Existing chats keep their own. */
  account: string | null;
  /** "Freie Chats" (chats without a project, in the home folder). */
  free: boolean;
  /** Changes whenever the icon changes (part of the icon URL, so the picture refreshes); null = none. */
  icon: string | null;
}

/** A task in NOLA (Samu's Kanban app). */
export interface NolaTask {
  id: number;
  title: string;
  boardId: number;
  boardName: string;
  column: string;
  done: boolean;
  due: string | null;
  overdue: boolean;
  tags: string[];
  subtasksDone: number;
  subtasksTotal: number;
  url: string | null;
}

export interface NolaTaskDetail extends NolaTask {
  description: string;
  subtasks: { index: number; text: string; checked: boolean }[];
  comments: { author: string; body: string; at: string | null }[];
}

/** A task handed from the laptop to the server, as the laptop sees it. */
export interface HandoffView {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  createdAt: number;
  /** Status of the Claude tab on the server (null = unknown, server not reachable). */
  status: TabStatus | string | null;
  question: string | null;
  serverTabId: string;
  serverProjectId: string;
}

/** Laptop: the server tasks can be handed to. */
export interface ServerView {
  url: string;
  /** When the long-lived Claude token was sent (null = not yet). */
  tokenAt: number | null;
  reachable: boolean | null;
  checkedAt: number;
  handoffs: HandoffView[];
}

/** Phone access over Tailscale. */
export interface RemoteView {
  installed: boolean;
  running: boolean;
  /** tailscale serve publishes Otterdeck in the tailnet. */
  enabled: boolean;
  url: string | null;
  owner: string | null;
  error: string | null;
  /** Devices that have Otterdeck open over the tailnet right now. */
  devices: { name: string; since: number }[];
}

export interface UsageWindow {
  key: string;
  /** e.g. "Aktuelle Sitzung", "Woche, alle Modelle" */
  label: string;
  percent: number;
  resetsAt: number | null;
}

/** Plan usage limits of one account, as last reported by a Claude session (status line). */
export interface UsageView {
  account: string;
  /** When it was reported (ms). */
  at: number;
  windows: UsageWindow[];
}

export interface AccountView {
  /** Absolute config dir. */
  dir: string;
  label: string;
  email: string | null;
  isDefault: boolean;
}

/** The laptop as the server sees it: online or not, and its projects with their state. */
export interface LaptopView {
  url: string;
  online: boolean | null;
  checkedAt: number;
  /** Last time it answered. */
  seenAt: number;
  projects: {
    id: string;
    name: string;
    group: string | null;
    lastUsed: number;
    tabs: number;
    attention: 'waiting' | 'working' | 'done' | null;
  }[];
}

export interface AppState {
  projects: ProjectView[];
  tabs: TabView[];
  accounts: AccountView[];
  /** Group name → icon version for groups that have an own icon. */
  groupIcons: Record<string, string>;
  usage: UsageView[];
  remote: RemoteView;
  /** Laptop: connected server and the tasks running there (null = none set up). */
  server: ServerView | null;
  /** This Otterdeck is itself a server (Linux, OTTER_SERVER=1). */
  serverMode: boolean;
  /** NOLA can be reached (laptop with the nola.ps1 helper). */
  nola: boolean;
  /** The Antigravity CLI (agy) is installed: tabs with Google's agent next to Claude. */
  agy: boolean;
  /** Server mode: where the laptop's Otterdeck is (it tells the server), for "Zum Laptop". */
  laptopUrl: string | null;
  /** Server mode: the laptop's projects and whether it is on (null = laptop never reported). */
  laptop: LaptopView | null;
  /** Path separator and home folder of the machine Otterdeck runs on (folder fields). */
  sep: string;
  home: string;
  /** This window is the remote page (phone), not the PC. */
  isRemote?: boolean;
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
  /** Claude config dir the chat belongs to ("agy" for Antigravity). */
  account: string;
  /** Which CLI it came from (missing = Claude). */
  provider?: 'claude' | 'agy';
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

/** A subagent Claude started (Agent/Task tool): what it does right now, read from its own transcript. */
export interface AgentRun {
  type: string;
  description: string;
  /** Claude Code marked it finished (a background agent finishes long after its tool call). */
  done: boolean;
  /** The newest steps (tool calls) of the subagent. */
  steps: { name: string; summary: string; error: boolean }[];
  /** All steps so far, also the ones no longer in `steps`. */
  total: number;
  /** Its latest words (short), e.g. what it says it is doing. */
  said: string | null;
}

/** One thing in the chat, built from Claude's transcript. Same id = same thing (updates replace it). */
export type ChatItem =
  /**
   * Your message. queued: sent while Claude was working – 'waiting' in Claude Code's queue, or 'read'
   * (Claude took it in during its turn). gone: it became a normal message (shown as that instead).
   */
  | { id: string; k: 'user'; text: string; images: number; at: number; queued?: 'waiting' | 'read'; gone?: boolean }
  | { id: string; k: 'text'; text: string; at: number }
  | { id: string; k: 'thinking'; text: string; at: number }
  | { id: string; k: 'tool'; name: string; summary: string; input: Record<string, unknown>; result: ToolResult | null; at: number; agent?: AgentRun }
  | { id: string; k: 'note'; text: string; at: number }
  /** A command run with "!" (Claude Code's bash mode): Claude sees it and its output. out = null while it runs. */
  | { id: string; k: 'shell'; cmd: string; out: string | null; err: string; at: number };

export type ChatServerMsg =
  | { t: 'reset'; items: ChatItem[]; truncated: boolean }
  | { t: 'upsert'; items: ChatItem[] };

/** Messages on /ws/events */
export type EventMsg = { t: 'state'; state: AppState } | { t: 'changes'; projectId: string } | { t: 'toast'; text: string };

/** Messages on /ws/term */
export type TermClientMsg =
  | { t: 'in'; d: string }
  | { t: 'resize'; cols: number; rows: number };

export type TermServerMsg =
  | { t: 'snapshot'; d: string }
  | { t: 'out'; d: string }
  | { t: 'exit'; code: number | null };
