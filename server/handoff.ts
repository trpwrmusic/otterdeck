// "Auf Server abgeben": a Claude task moves from the laptop to an Otterdeck running on a server
// (e.g. mc-panel) and later comes back. Both sides live in this file:
//
//   laptop                                   server (OTTER_SERVER=1)
//   ------                                   ------
//   snapshot working tree → otter/<id>       POST /api/handoff/upload  (bundle, transcript)
//   git bundle + chat transcript   ───────►  POST /api/handoff/start   → clone, resume chat, prompt
//                                            Claude works; phone talks to the server directly
//   "Zurückholen"                  ◄───────  GET  /api/handoff/<id>/result (bundle of the result)
//   apply changes, resume chat               GET  /api/handoff/<id>/transcript, POST …/close
//
// The two talk over Tailscale; the server's `tailscale serve` adds the caller's identity, which the
// server checks like any other remote request (remote.ts).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { CLAUDE_TOKEN_FILE, DATA_DIR, DEFAULT_CLAUDE_DIR, HOME, SERVER_MODE } from './config.ts';
import { data, newId, save, type HandoffRecord } from './store.ts';
import { closeTab, createTab, tabs } from './tabs.ts';
import { encodeProjectDir } from './claudeData.ts';
import type { HandoffView, ServerView } from '../shared/types.ts';

const HANDOFF_DIR = path.join(DATA_DIR, 'handoff');
/** Server: where handed-over tasks get their own checkout. */
const TASK_DIR = process.env.OTTER_TASK_DIR || path.join(HOME, 'otter-tasks');

function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())),
    );
  });
}

/**
 * Everything in the folder as one commit on top of HEAD (tracked changes and new files, respecting
 * .gitignore) without touching the real index or working tree.
 */
async function snapshot(dir: string, message: string): Promise<string> {
  const index = path.join(os.tmpdir(), `otter-index-${newId()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
    if (head) await git(dir, ['read-tree', 'HEAD'], env);
    await git(dir, ['add', '-A'], env);
    const tree = await git(dir, ['write-tree'], env);
    const who = { GIT_AUTHOR_NAME: 'Otterdeck', GIT_AUTHOR_EMAIL: 'otterdeck@localhost', GIT_COMMITTER_NAME: 'Otterdeck', GIT_COMMITTER_EMAIL: 'otterdeck@localhost' };
    return await git(dir, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], who);
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Rewrites the working folder recorded in each line of a transcript (laptop path ↔ server path). */
function moveTranscript(text: string, cwd: string) {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      try {
        const j = JSON.parse(line);
        if (typeof j.cwd === 'string') j.cwd = cwd;
        return JSON.stringify(j);
      } catch {
        return line;
      }
    })
    .join('\n');
}

const chatFile = (account: string, dir: string, sessionId: string) => path.join(account, 'projects', encodeProjectDir(dir), `${sessionId}.jsonl`);

// =====================================================================================
// server side
// =====================================================================================

/** Claude's first start on a fresh machine asks about theme and folder trust; answer that up front. */
function prepareClaude(dir: string) {
  const file = path.join(HOME, '.claude.json');
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  cfg.hasCompletedOnboarding = true;
  cfg.theme ??= 'dark';
  cfg.projects ??= {};
  const key = dir.replace(/\\/g, '/');
  cfg.projects[key] = { ...(cfg.projects[key] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

async function readRaw(req: http.IncomingMessage, file: string, limit = 500 * 1024 * 1024) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('Zu groß.');
      out.write(c);
    }
  } catch (err) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw err;
  }
  await new Promise((r) => out.end(r));
  return size;
}

const safeId = (s: unknown) => (typeof s === 'string' && /^[a-f0-9]{6,32}$/.test(s) ? s : null);

export function serverInfo() {
  let tokenAt: number | null = null;
  try {
    tokenAt = fs.statSync(CLAUDE_TOKEN_FILE).mtimeMs;
  } catch {}
  return { server: SERVER_MODE, hostname: os.hostname(), tokenAt, freeMemory: os.freemem(), totalMemory: os.totalmem() };
}

export function storeToken(token: string) {
  if (!/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Das sieht nicht wie ein Claude-Schlüssel aus.');
  fs.writeFileSync(CLAUDE_TOKEN_FILE, token + '\n', { mode: 0o600 });
  fs.chmodSync(CLAUDE_TOKEN_FILE, 0o600);
}

export async function receiveUpload(req: http.IncomingMessage, id: string, kind: string) {
  if (!safeId(id) || !/^(bundle|transcript)$/.test(kind)) throw new Error('id/kind');
  return readRaw(req, path.join(HANDOFF_DIR, id, kind));
}

export async function startTask(body: any) {
  const id = safeId(body.id);
  if (!id) throw new Error('id');
  const name = String(body.name ?? 'aufgabe').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'aufgabe';
  const dir = path.join(TASK_DIR, `${name}-${id}`);
  const bundle = path.join(HANDOFF_DIR, id, 'bundle');
  if (!fs.existsSync(bundle)) throw new Error('Kein Code hochgeladen.');
  fs.mkdirSync(TASK_DIR, { recursive: true });
  if (!fs.existsSync(dir)) await git(TASK_DIR, ['clone', '-q', '-b', `otter/${id}`, bundle, dir]);
  await git(dir, ['remote', 'remove', 'origin']).catch(() => {});
  // Commits Claude makes there need a name.
  await git(dir, ['config', 'user.name', String(body.gitName || 'Otterdeck')]);
  await git(dir, ['config', 'user.email', String(body.gitEmail || 'otterdeck@localhost')]);
  const base = await git(dir, ['rev-parse', 'HEAD']);

  // The conversation so far, so Claude continues with everything it knew on the laptop.
  let resume: string | undefined;
  const transcript = path.join(HANDOFF_DIR, id, 'transcript');
  const sessionId = typeof body.sessionId === 'string' && /^[\w-]{8,64}$/.test(body.sessionId) ? body.sessionId : null;
  if (sessionId && fs.existsSync(transcript)) {
    const dest = chatFile(DEFAULT_CLAUDE_DIR, dir, sessionId);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, moveTranscript(fs.readFileSync(transcript, 'utf8'), dir));
    resume = sessionId;
  }
  prepareClaude(dir);

  const now = Date.now();
  const project = { id: newId(), path: dir, name: String(body.title || name).slice(0, 60), group: 'Vom Laptop', addedAt: now, lastUsed: now, handoff: { id, base, from: String(body.from ?? '') } };
  data.projects.push(project);
  save();
  const mode = typeof body.mode === 'string' ? body.mode : undefined;
  const tab = createTab(project.id, 'claude', resume, String(body.prompt ?? '').trim() || undefined, undefined, { mode });
  return { projectId: project.id, tabId: tab.rec.id };
}

function taskProject(id: string) {
  return data.projects.find((p) => p.handoff?.id === id) ?? null;
}

/** The result as a git bundle on top of the state that was handed over. */
export async function resultBundle(id: string) {
  const p = taskProject(id);
  if (!p?.handoff) throw new Error('Diese Aufgabe gibt es auf dem Server nicht.');
  const busy = data.tabs.some((t) => t.projectId === p.id && tabs.get(t.id)?.status === 'working');
  if (busy) throw new Error('Claude arbeitet auf dem Server noch. Warte, bis er fertig ist, oder halte ihn an.');
  const done = await snapshot(p.path, 'Otterdeck: Ergebnis der Server-Aufgabe');
  await git(p.path, ['update-ref', `refs/heads/otter/${id}-done`, done]);
  const file = path.join(HANDOFF_DIR, id, 'result.bundle');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const range = done === p.handoff.base ? [`otter/${id}-done`] : [`otter/${id}-done`, `^${p.handoff.base}`];
  await git(p.path, ['bundle', 'create', file, ...range]);
  return { file, done };
}

export function resultTranscript(id: string) {
  const p = taskProject(id);
  if (!p) return null;
  const rec = data.tabs.find((t) => t.projectId === p.id && t.kind === 'claude');
  const tab = rec ? tabs.get(rec.id) : undefined;
  const file = tab?.transcriptFile();
  if (!file || !fs.existsSync(file)) return null;
  return { file, sessionId: path.basename(file, '.jsonl') };
}

export function closeTask(id: string) {
  const p = taskProject(id);
  if (!p) return;
  for (const t of data.tabs.filter((t) => t.projectId === p.id)) closeTab(t.id);
  data.projects = data.projects.filter((x) => x.id !== p.id);
  save();
  // The checkout stays in ~/otter-tasks for a while, in case something has to be looked up.
  fs.rmSync(path.join(HANDOFF_DIR, id), { recursive: true, force: true });
}

// =====================================================================================
// laptop side
// =====================================================================================

async function call(pathname: string, init: RequestInit & { raw?: boolean } = {}) {
  const url = data.server?.url;
  if (!url) throw new Error('Kein Server verbunden.');
  let res: Response;
  try {
    res = await fetch(url + pathname, {
      ...init,
      // The server checks the origin like for any page request.
      headers: { origin: url, ...(init.headers as Record<string, string>) },
      signal: init.signal ?? AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new Error(`Server nicht erreichbar (${(err as Error).message}). Läuft er, und ist Tailscale an?`);
  }
  if (!res.ok) {
    const j: any = await res.json().catch(() => ({}));
    throw new Error(j.error || `Server: ${res.status}`);
  }
  return res;
}

export async function setServer(url: string) {
  const clean = url.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+\.ts\.net(:\d+)?$/i.test(clean)) throw new Error('Bitte die Tailscale-Adresse des Servers (https://….ts.net:Port).');
  data.server = { url: clean, tokenAt: data.server?.tokenAt };
  save();
  const info = await (await call('/api/server/info')).json();
  if (!info.server) throw new Error('Dort läuft Otterdeck nicht im Server-Modus.');
  return info;
}

/** Starts `claude setup-token` in a tab and sends the token to the server as soon as it appears. */
export function connectToken(projectId: string, onDone: (err: Error | null) => void) {
  const tab = createTab(projectId, 'shell', undefined, undefined, undefined, { setupToken: true });
  let seen = '';
  const watch = (d: string) => {
    // Strip colours and line breaks the terminal may put inside the long token.
    seen = (seen + d.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\r\n]/g, '')).slice(-4000);
    const m = seen.match(/sk-ant-oat01-[A-Za-z0-9_-]{60,}/);
    if (!m) return;
    tab.watchers.delete(watch);
    // Give the terminal a moment so the whole token has arrived.
    setTimeout(async () => {
      const full = (seen.match(/sk-ant-oat01-[A-Za-z0-9_-]+/) ?? m)[0];
      try {
        await call('/api/server/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: full }) });
        data.server = { ...data.server!, tokenAt: Date.now() };
        save();
        closeTab(tab.rec.id); // the token is on that screen; don't leave it around
        onDone(null);
      } catch (err) {
        onDone(err as Error);
      }
    }, 600);
  };
  tab.watchers.add(watch);
  return tab.rec.id;
}

export async function handOff(tabId: string, prompt: string, gitName?: string, gitEmail?: string) {
  const tab = tabs.get(tabId);
  if (!tab || tab.rec.kind !== 'claude') throw new Error('Nur Claude-Tabs lassen sich abgeben.');
  if (tab.status === 'working') throw new Error('Claude arbeitet gerade. Warte, bis er fertig ist, oder halte ihn an.');
  const project = data.projects.find((p) => p.id === tab.rec.projectId);
  if (!project) throw new Error('Projekt fehlt.');
  const top = await git(project.path, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (!top) throw new Error('Abgeben geht im Moment nur bei Git-Projekten.');

  const id = newId();
  const base = await snapshot(project.path, `Otterdeck: Stand beim Abgeben an den Server\n\n${prompt}`);
  await git(project.path, ['update-ref', `refs/heads/otter/${id}`, base]);
  const bundle = path.join(HANDOFF_DIR, `${id}.bundle`);
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  await git(project.path, ['bundle', 'create', bundle, `otter/${id}`]);
  try {
    await call(`/api/handoff/upload?id=${id}&kind=bundle`, { method: 'POST', body: fs.readFileSync(bundle) });
    const chat = tab.transcriptFile();
    const sessionId = chat && fs.existsSync(chat) ? path.basename(chat, '.jsonl') : null;
    if (chat && sessionId) await call(`/api/handoff/upload?id=${id}&kind=transcript`, { method: 'POST', body: fs.readFileSync(chat) });
    const title = tab.view().title && tab.view().title !== 'Claude' ? tab.view().title : project.name || path.basename(project.path);
    const res = await call('/api/handoff/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: path.basename(project.path), title, from: project.path, sessionId, prompt, mode: tab.view().mode ?? undefined, gitName, gitEmail }),
    });
    const { projectId: serverProjectId, tabId: serverTabId } = await res.json();
    const rec: HandoffRecord = { id, projectId: project.id, title, prompt, base, serverProjectId, serverTabId, createdAt: Date.now() };
    (data.handoffs ??= []).push(rec);
    save();
    // The laptop's tab stops, so the same chat doesn't go on in two places.
    closeTab(tabId);
    return rec;
  } finally {
    fs.rmSync(bundle, { force: true });
  }
}

export async function bringBack(id: string) {
  const h = data.handoffs?.find((x) => x.id === id && !x.returnedAt);
  if (!h) throw new Error('Diese Aufgabe gibt es nicht (mehr).');
  const project = data.projects.find((p) => p.id === h.projectId);
  if (!project) throw new Error('Das Projekt auf dem Laptop fehlt.');

  // 1. code: fetch the result and put its changes into the working tree, unstaged
  const res = await call(`/api/handoff/${id}/result`);
  const file = path.join(HANDOFF_DIR, `${id}-result.bundle`);
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  let conflict = false;
  try {
    await git(project.path, ['fetch', '-q', file, `otter/${id}-done:refs/heads/otter/${id}-done`]);
    const diff = await git(project.path, ['diff', '--binary', h.base, `otter/${id}-done`]);
    if (diff) {
      const patch = path.join(HANDOFF_DIR, `${id}.patch`);
      fs.writeFileSync(patch, diff + '\n');
      try {
        await git(project.path, ['apply', '--whitespace=nowarn', patch]);
      } catch {
        // The laptop's folder changed meanwhile: merge with conflict markers instead of failing.
        await git(project.path, ['apply', '--3way', '--whitespace=nowarn', patch]).catch(() => {
          conflict = true;
        });
      } finally {
        fs.rmSync(patch, { force: true });
      }
    }
  } finally {
    fs.rmSync(file, { force: true });
  }

  // 2. chat: the server's conversation replaces the laptop's copy, then it goes on here
  let tabId: string | null = null;
  try {
    const t = await call(`/api/handoff/${id}/transcript`);
    const sessionId = t.headers.get('x-otter-session');
    if (sessionId && /^[\w-]{8,64}$/.test(sessionId)) {
      const account = project.account || DEFAULT_CLAUDE_DIR;
      const dest = chatFile(account, project.path, sessionId);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, moveTranscript(await t.text(), project.path));
      tabId = createTab(project.id, 'claude', sessionId).rec.id;
    }
  } catch {}

  if (!conflict) await call(`/api/handoff/${id}/close`, { method: 'POST' }).catch(() => {});
  h.returnedAt = Date.now();
  save();
  return { tabId, conflict, branch: `otter/${id}-done` };
}

// ---------- status of the server's tasks, for the laptop's sidebar ----------

let remoteTabs = new Map<string, { status: string; title: string; question: string | null }>();
let reachable: boolean | null = null;
let checkedAt = 0;

export async function pollServer(changed: () => void) {
  if (!data.server?.url) return;
  const open = (data.handoffs ?? []).filter((h) => !h.returnedAt);
  try {
    const st = await (await call('/api/state', { signal: AbortSignal.timeout(8000) })).json();
    const next = new Map<string, { status: string; title: string; question: string | null }>();
    for (const t of st.tabs ?? []) next.set(t.id, { status: t.status, title: t.title, question: t.question ?? t.activity ?? null });
    const before = JSON.stringify([...remoteTabs]) + reachable;
    remoteTabs = next;
    reachable = true;
    if (before !== JSON.stringify([...remoteTabs]) + reachable && open.length) changed();
  } catch {
    if (reachable !== false) {
      reachable = false;
      changed();
    }
  }
  checkedAt = Date.now();
}

export function serverView(): ServerView | null {
  if (!data.server) return null;
  return {
    url: data.server.url,
    tokenAt: data.server.tokenAt ?? null,
    reachable,
    checkedAt,
    handoffs: (data.handoffs ?? [])
      .filter((h) => !h.returnedAt)
      .map((h): HandoffView => {
        const t = remoteTabs.get(h.serverTabId);
        return { id: h.id, projectId: h.projectId, title: t?.title && t.title !== 'Claude' ? t.title : h.title, prompt: h.prompt, createdAt: h.createdAt, status: t?.status ?? null, question: t?.question ?? null, serverTabId: h.serverTabId, serverProjectId: h.serverProjectId };
      }),
  };
}
