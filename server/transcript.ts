// Reads a Claude Code transcript (JSONL) as chat items and follows it while it grows.
import fs from 'node:fs';
import type { ChatItem, ToolResult } from '../shared/types.ts';
import { describeTool } from './hooks.ts';

/** Long chats: only the end is read at first (transcripts reach many MB). */
const INITIAL_BYTES = 3 * 1024 * 1024;
const MAX_ITEMS = 400;
const MAX_TEXT = 40_000;
const MAX_RESULT = 6_000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…' : s);

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
  private items = new Map<string, ChatItem>();
  private order: string[] = [];
  private toolIndex = new Map<string, string>(); // tool_use_id → item id
  private lastShell: string | null = null; // the "!" command waiting for its output
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
    return this.list();
  }

  list() {
    const ids = this.order.slice(-MAX_ITEMS);
    if (this.order.length > MAX_ITEMS) this.truncated = true;
    return ids.map((id) => this.items.get(id)!).filter(Boolean);
  }

  /** Reads new lines; returns the items that appeared or changed. */
  poll(): ChatItem[] {
    return this.read(false);
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

  private put(it: ChatItem) {
    if (!this.items.has(it.id)) this.order.push(it.id);
    this.items.set(it.id, it);
    return it;
  }

  private entry(j: any): ChatItem[] {
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
          out.push(this.put(item));
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
    if (j.type === 'system' && j.subtype === 'compact_boundary') return [this.put({ id: j.uuid, k: 'note', text: 'Gespräch verdichtet', at })];
    return [];
  }
}
