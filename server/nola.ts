// NOLA (Samuel's Kanban app) inside Otterdeck: the project's NOLA card and to-dos in the side panel,
// handing a task to Claude, NOLA tasks in the search.
//
// All calls go through the helper ~\bin\nola.ps1 (path in the settings), which reads the API key from the
// Windows credential store; Otterdeck never sees the key. Only on the laptop (Windows).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, IS_WIN, SETTINGS } from './config.ts';
import { newId } from './store.ts';
import type { NolaTask, NolaTaskDetail } from '../shared/types.ts';

export const FOUND_NOLA = path.join(HOME, 'bin', 'nola.ps1');
const HELPER = SETTINGS.nolaHelper || FOUND_NOLA;
export const NOLA_AVAILABLE = IS_WIN && SETTINGS.nolaEnabled && fs.existsSync(HELPER);

/** Boards Otterdeck reads: project cards and the personal to-do list. */
const PROJECT_BOARD = SETTINGS.nolaProjectsBoard || 5;
const TODO_BOARDS = SETTINGS.nolaTodoBoards.split(',').map(Number).filter(Boolean);

export function nola(method: string, apiPath: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!NOLA_AVAILABLE) return reject(new Error('NOLA ist hier nicht eingerichtet.'));
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, method, apiPath];
    let tmp: string | null = null;
    if (body !== undefined) {
      tmp = path.join(os.tmpdir(), `otter-nola-${newId()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
      args.push('-File', tmp);
    }
    execFile('powershell.exe', args, { timeout: 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (tmp) fs.rmSync(tmp, { force: true });
      const out = String(stdout ?? '').trim();
      const http = out.match(/^HTTP (\d{3})\s*([\s\S]*)$/);
      if (http) {
        let msg = `NOLA: ${http[1]}`;
        try {
          msg = JSON.parse(http[2]).message || msg;
        } catch {}
        return reject(new Error(msg));
      }
      if (err && !out) return reject(new Error((stderr || err.message).trim()));
      try {
        const j = JSON.parse(out);
        resolve(j?.data ?? j);
      } catch {
        reject(new Error('NOLA hat unerwartet geantwortet.'));
      }
    });
  });
}

// ---------- cached board contents ----------

interface Board {
  id: number;
  name: string;
  columns: { id: number; name: string; tasks: any[] }[];
}
const boards = new Map<number, { at: number; board: Board }>();

async function board(id: number, fresh = false): Promise<Board> {
  const hit = boards.get(id);
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.board;
  const b = await nola('GET', `/boards/${id}`);
  boards.set(id, { at: Date.now(), board: b });
  return b;
}
const forget = (boardId?: number) => (boardId ? boards.delete(boardId) : boards.clear());

function view(t: any, b: Board, col: { id: number; name: string }): NolaTask {
  // subtasks: { done, total, items: [{ index, text, checked }] }
  const subs = t.subtasks ?? {};
  return {
    id: t.id,
    title: t.title,
    boardId: b.id,
    boardName: b.name,
    column: col.name,
    done: /erledigt|done/i.test(col.name),
    due: t.due_date ?? null,
    overdue: !!t.overdue,
    tags: (t.tags ?? []).map((x: any) => x.name ?? String(x)),
    subtasksDone: Number(subs.done ?? 0),
    subtasksTotal: Number(subs.total ?? 0),
    url: t.url ?? null,
  };
}

async function allTasks(fresh = false): Promise<NolaTask[]> {
  const out: NolaTask[] = [];
  for (const id of [PROJECT_BOARD, ...TODO_BOARDS]) {
    try {
      const b = await board(id, fresh);
      for (const c of b.columns ?? []) for (const t of c.tasks ?? []) out.push(view(t, b, c));
    } catch {}
  }
  return out;
}

// ---------- which tasks belong to an Otterdeck project ----------

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Names a project goes by: its own name, its group, the folder ("Heidehof", "App" → only "Heidehof"). */
function namesOf(p: { name: string; group: string | null; folder: string }) {
  const names = [p.group, p.name, p.folder].filter((x): x is string => !!x).map(norm);
  // Child names like "App" or "Website" alone say nothing; inside a group only the group counts.
  const generic = /^(app|website|web|plugin|video|tdot \d+|api)$/;
  return [...new Set(names.filter((n) => n.length >= 3 && !generic.test(n)))];
}

/** "Stakz (WordPress-…)" or "Stakz: Bewertungen-Block" starts with one of the names. */
function matches(title: string, names: string[]) {
  const t = norm(title);
  return names.some((n) => t === n || t.startsWith(n + ' '));
}

export async function projectTasks(p: { name: string; group: string | null; folder: string; nolaCard?: number }, fresh = false) {
  const names = namesOf(p);
  const tasks = await allTasks(fresh);
  const cards = tasks.filter((t) => t.boardId === PROJECT_BOARD);
  const card = (p.nolaCard ? cards.find((c) => c.id === p.nolaCard) : undefined) ?? cards.find((c) => matches(c.title, names)) ?? null;
  const todos = tasks
    .filter((t) => t.boardId !== PROJECT_BOARD && matches(t.title.split(':')[0], names))
    .sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9').localeCompare(b.due ?? '9'));
  return { card, todos, names };
}

/** The Otterdeck project a NOLA task belongs to (by name), if any. */
export function projectFor(task: NolaTask, projects: { id: string; name: string; group: string | null; folder: string; nolaCard?: number }[]) {
  const head = task.boardId === PROJECT_BOARD ? task.title : task.title.split(':')[0];
  return projects.find((p) => p.nolaCard === task.id) ?? projects.find((p) => matches(head, namesOf(p))) ?? null;
}

export async function searchTasks(q: string) {
  const n = norm(q);
  const tasks = await allTasks();
  return (n ? tasks.filter((t) => norm(t.title).includes(n)) : tasks).filter((t) => !t.done).slice(0, 200);
}

export async function taskDetail(id: number): Promise<NolaTaskDetail> {
  const t = await nola('GET', `/tasks/${id}`);
  const b = await board(t.board_id).catch(() => null);
  const col = b?.columns.find((c) => c.id === t.column_id);
  return {
    ...(b && col ? view(t, b, col) : { id: t.id, title: t.title, boardId: t.board_id, boardName: '', column: '', done: false, due: t.due_date ?? null, overdue: !!t.overdue, tags: [], subtasksDone: 0, subtasksTotal: 0, url: t.url ?? null }),
    description: t.description_text ?? '',
    subtasks: (t.subtasks?.items ?? []).map((s: any, i: number) => ({ index: s.index ?? i, text: s.text, checked: !!s.checked })),
    comments: (t.comments ?? []).slice(-5).map((c: any) => ({ author: c.user?.name ?? c.author?.name ?? '', body: c.body_text ?? String(c.body ?? '').replace(/<[^>]+>/g, ''), at: c.created_at ?? null })),
  };
}

export async function setSubtask(id: number, index: number, checked: boolean) {
  await nola('PATCH', `/tasks/${id}/subtasks/${index}`, { checked });
  forget();
}

/** Moves a task to the column of its board whose name matches (Erledigt, In Arbeit, Offen). */
export async function moveTask(id: number, to: 'done' | 'doing' | 'open') {
  const t = await nola('GET', `/tasks/${id}`);
  const b = await board(t.board_id, true);
  const re = to === 'done' ? /erledigt|done/i : to === 'doing' ? /in arbeit|doing|progress/i : /offen|open|todo/i;
  const col = b.columns.find((c) => re.test(c.name));
  if (!col) throw new Error(`Im Board „${b.name}“ fehlt eine passende Spalte.`);
  if (col.id !== t.column_id) await nola('POST', `/tasks/${id}/move`, { column_id: col.id });
  forget(t.board_id);
  return { boardId: b.id, columns: Object.fromEntries(b.columns.map((c) => [c.name, c.id])) };
}

/** The first message for a Claude tab that works on a NOLA task. */
export async function claudePrompt(id: number) {
  const t = await taskDetail(id);
  const moved = await moveTask(id, 'doing').catch(() => null);
  const done = moved ? Object.entries(moved.columns).find(([n]) => /erledigt|done/i.test(n))?.[1] : undefined;
  const helper = `powershell -NoProfile -ExecutionPolicy Bypass -File ${HELPER.replace(/\\/g, '/')}`;
  const lines = [
    `Arbeite bitte die NOLA-Aufgabe #${t.id} ab: „${t.title}“ (Board „${t.boardName}“).`,
    t.description.trim() ? `\nBeschreibung:\n${t.description.trim()}` : '',
    t.subtasks.length ? `\nUnteraufgaben:\n${t.subtasks.map((s) => `${s.index}. [${s.checked ? 'x' : ' '}] ${s.text}`).join('\n')}` : '',
    t.comments.length ? `\nLetzte Kommentare:\n${t.comments.map((c) => `- ${c.author}: ${c.body.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}` : '',
    `\nHalte NOLA dabei auf Stand (Helfer: \`${helper} <METHOD> <Pfad> [-Json '…']\`):`,
    `- erledigte Unteraufgabe abhaken: PATCH /tasks/${t.id}/subtasks/<index> -Json '{"checked":true}'`,
    `- am Ende kurz kommentieren, was du gemacht hast: POST /tasks/${t.id}/comments -Json '{"body":"…"}'`,
    done ? `- wenn alles fertig ist, nach „Erledigt“ schieben: POST /tasks/${t.id}/move -Json '{"column_id":${done}}'` : '',
    `Frag nach, bevor du etwas löschst. Die Aufgabe steht schon auf „In Arbeit“.`,
  ];
  return { prompt: lines.filter(Boolean).join('\n'), title: t.title };
}
