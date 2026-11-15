// Reads a Claude Code transcript (JSONL) as chat items and follows it while it grows.
import fs from 'node:fs';
import path from 'node:path';
import type { ChatItem, ToolResult } from '../shared/types.ts';
import { describeTool } from './hooks.ts';

/** Long chats: only the end is read at first (transcripts reach many MB). */
const INITIAL_BYTES = 3 * 1024 * 1024;
const MAX_ITEMS = 400;
const MAX_TEXT = 40_000;
const MAX_RESULT = 6_000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…' : s);

/** How many of a subagent's newest steps travel with its card. */
const AGENT_STEPS = 40;

interface AgentState {
  id: string;
  toolUseId: string;
  type: string;
  description: string;
  done: boolean;
  offset: number;
  partial: string;
  size: number;
  steps: { name: string; summary: string; error: boolean }[];
  total: number;
  said: string | null;
  results: Map<string, { name: string; summary: string; error: boolean }>;
  /** Its last answer ended the turn (no further tool call). */
  ended: boolean;
  background: boolean;
  mtime: number;
}

function trimInput(name: string, input: any): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = clip(v, name === 'Write' || name === 'Edit' || name === 'MultiEdit' ? MAX_TEXT : 4000);
    else if (k === 'todos' || k === 'edits' || k === 'questions' || typeof v !== 'object') out[k] = v;
    else out[k] = clip(JSON.stringify(v), 2000);
  }
  return out;
}

function resultOf(block: any): ToolResult {
  const c = block.content;
  let text = '';
  let images = 0;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c))
    for (const b of c) {
      if (b.type === 'text') text += (text ? '\n' : '') + b.text;
      else if (b.type === 'image') images++;
    }
  return { text: clip(text, MAX_RESULT), error: !!block.is_error, images };
}

/** What a user entry says, or null when it's tool output / bookkeeping. */
function userText(content: unknown): { text: string; images: number } | null {
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return null;
  let text = '';
  let images = 0;
  for (const b of content as any[]) {
    if (b.type === 'text') text += (text ? '\n' : '') + b.text;
    else if (b.type === 'image') images++;
    else if (b.type === 'tool_result') return null;
  }
  return text || images ? { text, images } : null;
}

/** Output of a "!" command, without terminal colours and carriage returns. */
function shellText(s: string | undefined) {
  return clip(
    String(s ?? '')
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\r\n?/g, '\n')
      // Claude Code stores the output HTML-escaped ("HEAD -&gt; master").
      .replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[e as string]!)
      .replace(/\s+$/, ''),
    MAX_TEXT,
  );
}

/** Your message, a short note (slash command, interruption), or machinery to leave out. */
function classify(text: string): { kind: 'message' } | { kind: 'note'; text: string } | { kind: 'skip' } {
  const t = text.trim();
  if (/^\[Request interrupted by user/.test(t)) return { kind: 'note', text: 'Unterbrochen' };
  const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return { kind: 'note', text: `${cmd[1]}${args ? ' ' + args : ''}` };
  }
  // Command output, reminders, caveats and other wrapped machinery.
  if (/^<[a-z-]+>/.test(t)) return { kind: 'skip' };
  return { kind: 'message' };
}

export class TranscriptTail {
  private offset = 0;
  private partial = '';
  protected items = new Map<string, ChatItem>();
  private order: string[] = [];
  private toolIndex = new Map<string, string>(); // tool_use_id → item id
  private lastShell: string | null = null; // the "!" command waiting for its output
  private queue: { id: string; text: string }[] = []; // messages sent while Claude worked, not yet taken
  truncated = false;

  constructor(readonly file: string) {}

  /** Reads what is there so far. */
  load(): ChatItem[] {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    const start = Math.max(0, size - INITIAL_BYTES);
    this.truncated = start > 0;
    this.offset = start;
    this.partial = '';
    this.read(start > 0);
    this.pollAgents(true);
    return this.list();
  }

  list() {
    const ids = this.order.slice(-MAX_ITEMS);
    if (this.order.length > MAX_ITEMS) this.truncated = true;
    return ids.map((id) => this.items.get(id)!).filter(Boolean);
  }

  /** Reads new lines; returns the items that appeared or changed. */
  poll(): ChatItem[] {
    const out = this.read(false);
    const agents = this.pollAgents();
    if (!agents.length) return out;
    const ids = new Set(agents.map((a) => a.id));
    return [...out.filter((i) => !ids.has(i.id)), ...agents];
  }

  // ---------- subagents ----------
  // Claude Code keeps each subagent in <session>/subagents/agent-<id>.jsonl, next to a .meta.json that
  // names the Agent/Task call it belongs to (toolUseId) and whether it finished. We read them along
  // and hang the subagent's steps on that call, so the chat shows what it is doing.

  private agents = new Map<string, AgentState>(); // agentId → state
  private agentByTool = new Map<string, AgentState>(); // tool_use_id → state
  private agentScanAt = 0;

  private agentDir() {
    return path.join(path.dirname(this.file), path.basename(this.file, '.jsonl'), 'subagents');
  }

  /** Looks for new or changed subagents; returns the updated Agent tool items. */
  private pollAgents(force = false): ChatItem[] {
    const now = Date.now();
    const busy = [...this.agents.values()].some((a) => !a.done && this.toolIndex.has(a.toolUseId));
    // New subagents show up rarely: look for them every 2 s (every poll while one runs).
    if (!force && !busy && now - this.agentScanAt < 2000) return [];
    this.agentScanAt = now;
    const dir = this.agentDir();
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const touched = new Set<AgentState>();
    for (const n of names) {
      const m = n.match(/^agent-(.+)\.meta\.json$/);
      if (!m) continue;
      let a = this.agents.get(m[1]);
      if (a?.done && a.size >= 0 && !force) continue;
      let meta: any;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      } catch {
        continue;
      }
      if (!meta.toolUseId) continue;
      if (!a) {
        a = { id: m[1], toolUseId: meta.toolUseId, type: meta.agentType ?? 'Agent', description: meta.description ?? '', done: false, offset: 0, partial: '', size: -1, steps: [], total: 0, said: null, results: new Map(), ended: false, background: meta.requestShape === 'background', mtime: 0 };
        this.agents.set(a.id, a);
        this.agentByTool.set(a.toolUseId, a);
      }
      // Only subagents of calls we show (a long chat is read from its end).
      if (!this.toolIndex.has(a.toolUseId)) continue;
      const wasDone = a.done;
      const changed = this.readAgent(a, path.join(dir, `agent-${a.id}.jsonl`));
      // Finished: Claude Code says so (newer versions), its last answer ended the turn, a foreground
      // agent's call has its result, or nothing happened for 15 minutes.
      const call = this.items.get(this.toolIndex.get(a.toolUseId)!);
      a.done = !!meta.finished || a.ended || (!a.background && call?.k === 'tool' && !!call.result) || (a.mtime > 0 && now - a.mtime > 15 * 60_000);
      if (changed || a.done !== wasDone) touched.add(a);
    }
    const out: ChatItem[] = [];
    for (const a of touched) {
      const it = this.attachAgent(a.toolUseId);
      if (it) out.push(it);
    }
    return out;
  }

  /** Reads new lines of one subagent; true when something changed. */
  private readAgent(a: AgentState, file: string) {
    let size: number;
    try {
      const st = fs.statSync(file);
      size = st.size;
      a.mtime = st.mtimeMs;
    } catch {
      return false;
    }
    if (size === a.size) return false;
    // Very long subagents: only their end matters here.
    if (a.offset === 0 && size > INITIAL_BYTES) a.offset = size - INITIAL_BYTES;
    const fd = fs.openSync(file, 'r');
    let chunk: string;
    try {
      const buf = Buffer.alloc(size - a.offset);
      fs.readSync(fd, buf, 0, buf.length, a.offset);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    a.offset = size;
    a.size = size;
    const lines = (a.partial + chunk).split('\n');
    a.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const blocks: any[] = Array.isArray(j.message?.content) ? j.message.content : [];
      if (j.type === 'assistant') {
        a.ended = j.message?.stop_reason === 'end_turn' && !blocks.some((b) => b.type === 'tool_use');
        for (const b of blocks) {
          if (b.type === 'tool_use') {
            if (b.name === 'SubagentHandback') continue; // its final report: arrives as the call's result
            a.total++;
            const step = { name: b.name, summary: describeTool(b.name, b.input), error: false };
            a.results.set(b.id, step);
            a.steps.push(step);
            if (a.steps.length > AGENT_STEPS) a.steps.shift();
          } else if (b.type === 'text' && b.text?.trim()) a.said = clip(b.text.trim(), 400);
        }
      }
      else if (j.type === 'user')
        for (const b of blocks)
          if (b.type === 'tool_result' && b.is_error) {
            const s = a.results.get(b.tool_use_id);
            if (s) s.error = true;
          }
    }
    return true;
  }

  /** The Agent tool item with its subagent's progress, stored and returned (or null). */
  private attachAgent(toolUseId: string): ChatItem | null {
    const a = this.agentByTool.get(toolUseId);
    const itemId = this.toolIndex.get(toolUseId);
    const it = itemId ? this.items.get(itemId) : null;
    if (!a || !it || it.k !== 'tool') return null;
    return this.put({ ...it, agent: { type: a.type, description: a.description, done: a.done, steps: a.steps.map((s) => ({ ...s })), total: a.total, said: a.said } });
  }

  private read(skipFirstLine: boolean): ChatItem[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Rewritten (rare): start over.
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    let chunk: string;
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    this.offset = size;
    const text = this.partial + chunk;
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    if (skipFirstLine) lines.shift();
    const changed = new Map<string, ChatItem>();
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      for (const it of this.entry(j)) changed.set(it.id, it);
    }
    return [...changed.values()];
  }

  protected itemById(id: string) {
    return this.items.get(id);
  }

  protected put(it: ChatItem) {
    if (!this.items.has(it.id)) this.order.push(it.id);
    this.items.set(it.id, it);
    return it;
  }

  protected entry(j: any): ChatItem[] {
    const at = Date.parse(j.timestamp ?? '') || Date.now();
    if (j.isSidechain) return []; // subagents: their summary arrives as the Task tool's result
    if (j.type === 'assistant') {
      const out: ChatItem[] = [];
      const blocks: any[] = Array.isArray(j.message?.content) ? j.message.content : [];
      blocks.forEach((b, i) => {
        const id = `${j.uuid}:${i}`;
        if (b.type === 'text' && b.text?.trim()) out.push(this.put({ id, k: 'text', text: clip(b.text, MAX_TEXT), at }));
        else if (b.type === 'thinking' && b.thinking?.trim()) out.push(this.put({ id, k: 'thinking', text: clip(b.thinking, MAX_TEXT), at }));
        else if (b.type === 'tool_use') {
          const prev = this.toolIndex.get(b.id);
          const item: ChatItem = {
            id: prev ?? id,
            k: 'tool',
            name: b.name,
            summary: describeTool(b.name, b.input),
            input: trimInput(b.name, b.input),
            result: prev ? ((this.items.get(prev) as any)?.result ?? null) : null,
            at,
          };
          this.toolIndex.set(b.id, item.id);
          this.put(item);
          // A subagent already known (read before its call): keep showing its progress.
          out.push((this.agentByTool.has(b.id) && this.attachAgent(b.id)) || item);
        }
      });
      return out;
    }
    if (j.type === 'user') {
      if (j.isMeta) return [];
      // The summary Claude writes when it compacts is stored as a "user" message, but you didn't write it.
      // The compact boundary right before it already shows as "Gespräch verdichtet".
      if (j.isCompactSummary || j.isVisibleInTranscriptOnly) return [];
      const content = j.message?.content;
      // Tool results belong to their tool call.
      if (Array.isArray(content) && content.some((b: any) => b.type === 'tool_result')) {
        const out: ChatItem[] = [];
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const toolId = this.toolIndex.get(b.tool_use_id);
          const tool = toolId ? this.items.get(toolId) : null;
          if (tool && tool.k === 'tool') out.push(this.put({ ...tool, result: resultOf(b) }));
        }
        return out;
      }
      const u = userText(content);
      if (!u) return [];
      // "!" commands: <bash-input> first, then <bash-stdout>/<bash-stderr> as a second entry.
      const input = u.text.match(/^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/);
      if (input) {
        this.lastShell = j.uuid;
        return [this.put({ id: j.uuid, k: 'shell', cmd: shellText(input[1]).trim(), out: null, err: '', at })];
      }
      const stdout = u.text.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
      const stderr = u.text.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
      if (stdout || stderr) {
        const prev = this.lastShell ? this.items.get(this.lastShell) : undefined;
        const out = shellText(stdout?.[1]);
        const err = shellText(stderr?.[1]);
        this.lastShell = null;
        if (prev && prev.k === 'shell') return [this.put({ ...prev, out, err })];
        return [this.put({ id: j.uuid, k: 'shell', cmd: '', out, err, at })];
      }
      const c = classify(u.text);
      if (c.kind === 'skip') return [];
      if (c.kind === 'note') return [this.put({ id: j.uuid, k: 'note', text: c.text, at })];
      return [this.put({ id: j.uuid, k: 'user', text: clip(u.text, MAX_TEXT), images: u.images, at })];
    }
    // Messages you send while Claude works go into Claude Code's queue first. It takes them in
    // during the turn (remove: absorbed_mid_turn) or as the next turn (dequeue → a normal message).
    if (j.type === 'queue-operation') {
      const text = typeof j.content === 'string' ? j.content : '';
      if (j.operation === 'enqueue') {
        // Task notifications and other machinery queue up too: keep their place (a dequeue names no
        // text and takes the oldest entry), but show only your own words.
        const mine = !!text.trim() && !/^\s*</.test(text);
        const id = mine ? 'queue:' + (j.timestamp ?? at) + ':' + this.queue.length : '';
        this.queue.push({ id, text });
        return mine ? [this.put({ id, k: 'user', text: clip(text, MAX_TEXT), images: 0, at, queued: 'waiting' })] : [];
      }
      const idx = text ? this.queue.findIndex((q) => q.text === text) : 0;
      const q = idx >= 0 ? this.queue.splice(idx, 1)[0] : undefined;
      const item = q?.id ? this.items.get(q.id) : undefined;
      if (!item || item.k !== 'user') return [];
      if (j.operation === 'remove') return [this.put({ ...item, queued: 'read' })];
      if (j.operation === 'dequeue') return [this.put({ ...item, gone: true })];
      return [];
    }
    // The message as Claude got it mid-turn; shown already if its queue entry was read.
    if (j.type === 'attachment' && j.attachment?.type === 'queued_command') {
      const a = j.attachment;
      if (a.commandMode && a.commandMode !== 'prompt') return [];
      const text = typeof a.prompt === 'string' ? a.prompt : '';
      if (!text.trim() || /^\s*</.test(text)) return [];
      const known = [...this.items.values()].some((i) => i.k === 'user' && i.queued && i.text === clip(text, MAX_TEXT));
      if (known) return [];
      return [this.put({ id: j.uuid, k: 'user', text: clip(text, MAX_TEXT), images: 0, at, queued: 'read' })];
    }
    if (j.type === 'system' && j.subtype === 'compact_boundary') return [this.put({ id: j.uuid, k: 'note', text: 'Gespräch verdichtet', at })];
    return [];
  }
}
