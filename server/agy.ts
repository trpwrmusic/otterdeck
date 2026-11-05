// Antigravity CLI (`agy`, Google) as a second provider next to Claude Code.
//
// agy runs in the same pseudo-terminal as Claude. What differs is collected here:
//   - where the binary is, how a session starts and resumes (--conversation <id>, --mode, -i)
//   - its transcript (brain/<id>/.system_generated/logs/transcript_full.jsonl) → chat items
//   - its footer ("accept-edits · <model>") → permission mode
//   - its past conversations (cache/conversation_metadata.json) for "Weitermachen"
// Hooks come from ~/.gemini/config/hooks.json, which calls hook/otter-hook.mjs with "agy:<Event>".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatItem, Conversation, PermissionMode } from '../shared/types.ts';
import { describeTool } from './hooks.ts';
import { TranscriptTail } from './transcript.ts';

export const AGY_BIN =
  process.env.OTTER_AGY ||
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : path.join(os.homedir(), '.local', 'bin', 'agy'));
export const AGY_AVAILABLE = fs.existsSync(AGY_BIN);

const AGY_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');

export function agyTranscript(conversationId: string) {
  return path.join(AGY_DIR, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

/** The conversation agy last used in this folder (its own -c lookup). */
export function lastConversationFor(dir: string): string | null {
  try {
    const map = JSON.parse(fs.readFileSync(path.join(AGY_DIR, 'cache', 'last_conversations.json'), 'utf8'));
    const want = path.resolve(dir).toLowerCase();
    for (const [k, v] of Object.entries(map)) if (path.resolve(k).toLowerCase() === want && typeof v === 'string') return v;
  } catch {}
  return null;
}

/** Our mode names ↔ agy's (--mode and footer). */
const TO_AGY: Partial<Record<PermissionMode, string>> = { acceptEdits: 'accept-edits', auto: 'auto', plan: 'plan' };
export const agyModeFlag = (m: string | undefined) => (m ? TO_AGY[m as PermissionMode] : undefined);

/**
 * The mode from agy's footer: "? for shortcuts      accept-edits · Claude Opus 5.5 · medium".
 * No mode word before the model means the default mode.
 */
export function parseAgyMode(screen: string[]): PermissionMode | null {
  const lines = screen.filter((l) => l.trim());
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const l = lines[i];
    if (!/\? for shortcuts|esc to cancel|·/.test(l)) continue;
    const m = l.match(/\b(accept-edits|auto|plan)\s+·/);
    if (m) return m[1] === 'accept-edits' ? 'acceptEdits' : (m[1] as PermissionMode);
    if (/\? for shortcuts|esc to cancel/.test(l)) return 'default';
  }
  return null;
}

/** The model from agy's footer: "… accept-edits · Claude Opus 5.5 · medium" → "Claude Opus 5.5 (Medium)". */
export function agyModelLabel(screen: string[]): string | null {
  const lines = screen.filter((l) => l.trim());
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const m = lines[i].match(/(?:^|\s{2,})(?:(?:accept-edits|auto|plan)\s+·\s+)?([A-Z][\w .-]+?)\s+·\s+(low|medium|high|max)\s*$/i);
    if (m) return `${m[1].trim()} (${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()})`;
  }
  return null;
}

/** Footer says agy is busy ("esc to cancel") or idle ("? for shortcuts"). */
export function agyBusy(screen: string[]): boolean | null {
  const tail = screen.filter((l) => l.trim()).slice(-3).join('\n');
  if (/esc to cancel/.test(tail)) return true;
  if (/\? for shortcuts/.test(tail)) return false;
  return null;
}

// ---------- tools: agy's names/args → the ones the chat view knows ----------

export function mapTool(name: string, args: any = {}): { name: string; input: Record<string, unknown> } {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'run_command':
      return { name: 'Bash', input: { command: a.CommandLine ?? a.command ?? '', description: a.toolSummary } };
    case 'read_file':
    case 'view_file':
      return { name: 'Read', input: { file_path: a.Path ?? a.AbsolutePath ?? a.path ?? '' } };
    case 'write_file':
    case 'write_to_file':
      return { name: 'Write', input: { file_path: a.Path ?? a.TargetFile ?? a.path ?? '', content: a.Content ?? a.CodeContent ?? '' } };
    case 'replace_file_content':
    case 'edit_file':
      return {
        name: 'Edit',
        input: { file_path: a.Path ?? a.TargetFile ?? a.path ?? '', old_string: a.TargetContent ?? a.OldString ?? '', new_string: a.ReplacementContent ?? a.NewString ?? '' },
      };
    case 'grep_search':
      return { name: 'Grep', input: { pattern: a.Query ?? a.Pattern ?? '' } };
    case 'find_by_name':
    case 'list_dir':
      return { name: 'Glob', input: { pattern: a.Pattern ?? a.DirectoryPath ?? a.SearchDirectory ?? '' } };
    case 'read_url_content':
      return { name: 'WebFetch', input: { url: a.Url ?? '' } };
    case 'search_web':
      return { name: 'WebSearch', input: { query: a.query ?? a.Query ?? '' } };
    default:
      return { name, input: a };
  }
}

export const describeAgyTool = (name: string, args: any) => {
  const t = mapTool(name, args);
  return describeTool(t.name, t.input);
};

// ---------- transcript ----------

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…' : s);

/** The words you typed, without the metadata blocks agy adds around them. */
function userRequest(content: string): string | null {
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return m ? m[1] : null;
}

/** A tool step's output without agy's "Created At / Completed At" header. */
function stepOutput(content: unknown) {
  return String(content ?? '')
    .replace(/^(Created At|Completed At):.*\n?/gm, '')
    .replace(/^Encountered error in step execution:\s*/m, '')
    .trim();
}

/** Reads agy's transcript_full.jsonl as chat items (same interface as Claude's TranscriptTail). */
export class AgyTranscriptTail extends TranscriptTail {
  /** Tool items waiting for their result step, in call order. */
  private waiting: string[] = [];

  protected entry(j: any): ChatItem[] {
    const at = Date.parse(j.created_at ?? '') || Date.now();
    const step = j.step_index ?? Math.random();
    if (j.type === 'USER_INPUT') {
      const text = userRequest(String(j.content ?? ''));
      if (!text) return [];
      return [this.put({ id: `s${step}`, k: 'user', text: clip(text, 40_000), images: 0, at })];
    }
    if (j.type === 'PLANNER_RESPONSE') {
      const out: ChatItem[] = [];
      if (typeof j.thinking === 'string' && j.thinking.trim()) out.push(this.put({ id: `s${step}:th`, k: 'thinking', text: clip(j.thinking, 40_000), at }));
      if (typeof j.content === 'string' && j.content.trim()) out.push(this.put({ id: `s${step}:t`, k: 'text', text: clip(j.content, 40_000), at }));
      (Array.isArray(j.tool_calls) ? j.tool_calls : []).forEach((c: any, i: number) => {
        const t = mapTool(c.name, c.args);
        const id = `s${step}:${i}`;
        const prev = this.itemById(id);
        out.push(this.put({ id, k: 'tool', name: t.name, summary: describeTool(t.name, t.input), input: t.input, result: prev && prev.k === 'tool' ? prev.result : null, at }));
        if (!prev) this.waiting.push(id);
      });
      return out;
    }
    if (j.type === 'GENERIC' || j.source === 'MODEL') {
      // The result of the oldest tool call still waiting.
      const id = this.waiting.shift();
      const tool = id ? this.itemById(id) : undefined;
      if (!tool || tool.k !== 'tool') return [];
      const error = j.status === 'ERROR';
      const text = clip(stepOutput(j.content) || (error ? String(j.error ?? '') : ''), 6000);
      return [this.put({ ...tool, result: { text, error, images: 0 } })];
    }
    return [];
  }
}

/** The title agy gave a conversation (or its preview), from its own index. */
export function agyTitle(id: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(AGY_DIR, 'cache', 'conversation_metadata.json'), 'utf8'));
    const s = meta.conversations?.[id]?.summary;
    return String(s?.Title || s?.Preview || '').trim() || null;
  } catch {
    return null;
  }
}

// ---------- past conversations of a folder ----------

export function agyConversations(projectPath: string, limit = 9): Conversation[] {
  let meta: any;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(AGY_DIR, 'cache', 'conversation_metadata.json'), 'utf8'));
  } catch {
    return [];
  }
  const want = decodeURIComponent(pathToFileURL(path.resolve(projectPath)).href).toLowerCase();
  const out: Conversation[] = [];
  for (const c of Object.values<any>(meta.conversations ?? {})) {
    const s = c.summary ?? {};
    if (s.AppDataDir && s.AppDataDir !== 'antigravity-cli') continue;
    const uris: string[] = (s.WorkspaceURIs ?? []).map((u: string) => decodeURIComponent(u).toLowerCase());
    if (!uris.some((u) => u.replace(/\/$/, '') === want.replace(/\/$/, ''))) continue;
    const title = String(s.Title || s.Preview || '').trim();
    if (!title) continue;
    out.push({ sessionId: s.ID, title, updatedAt: Date.parse(s.UpdatedAt) || 0, account: 'agy', provider: 'agy' });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
