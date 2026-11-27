import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppState, EventMsg, ProjectView, SettingsView, TermClientMsg } from '../shared/types.ts';
import { claudeBin, DATA_DIR, DEFAULT_CLAUDE_DIR, DEV, DEV_WEB_PORT, findClaude, FOUND_SHELL, HOOK_TOKEN, HOST, ICON_DIR, PORT, SERVER_MODE, UPLOAD_DIR, WEB_DIST, HOME } from './config.ts';
import { recordUsage, usageViews } from './usage.ts';
import { FOUND_TASK_DIR, bringBack, closeTask, connectToken, handOff, pollServer, receiveUpload, resultBundle, resultTranscript, serverInfo, serverView, setServer, startTask, storeToken } from './handoff.ts';
import { AGY_AVAILABLE, FOUND_AGY, agyConversations } from './agy.ts';
import { laptopView, pollLaptopNow, startLaptopPoll } from './laptop.ts';
import { models, validModel } from './models.ts';
import { continuePrompt, exportChat } from './continue.ts';
import { FOUND_NOLA, NOLA_AVAILABLE, projectFor, claudePrompt, moveTask, projectTasks, searchTasks, setSubtask, taskDetail } from './nola.ts';
import { FOUND_TAILSCALE, isRemote, refreshRemote, remoteAllowed, remoteView, setRemote, trackDevice } from './remote.ts';
import { allChats, attachChat, conversations, lastChatAt, listAccounts, slashCommands, suggestions } from './claudeData.ts';
import { changes, fileDiff, listDir, readFile, safeJoin } from './git.ts';
import { writeHookSettings } from './hooks.ts';
import { shareMemory } from './memory.ts';
import { data, flush, newId, samePath, save } from './store.ts';
import { EFFORTS, closeTab, createTab, events, killAll, markSeen, restartTab, resumePending, tabs } from './tabs.ts';
import { respawn, update, version, watchForUpdates } from './update.ts';
import { fileEvents, keepWatching } from './watch.ts';
import { ENV, envFixed, needsRestart, savedSettings, settings, updateSettings } from './settings.ts';
import { checkForUpdate, installUpdate, updatable, updateView, watchReleases } from './release.ts';
import { autostartOn, setAutostart } from './autostart.ts';

writeHookSettings();

// Tell open windows when a project's files changed, so the changes panel reloads.
fileEvents.on('changed', (projectId: string) => {
  const s = JSON.stringify({ t: 'changes', projectId } satisfies EventMsg);
  for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send(s);
});
// One shared memory for every project (see memory.ts).
for (const p of data.projects) shareMemory(p.path, p.account || DEFAULT_CLAUDE_DIR);
resumePending();

// ---------- git branch, polled ----------

const branches = new Map<string, string | null>();

function readBranch(dir: string): string | null {
  try {
    let gitDir = path.join(dir, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch {
    return null;
  }
}

function pollBranches() {
  let diff = false;
  for (const p of data.projects) {
    const b = readBranch(p.path);
    if (branches.get(p.id) !== b) {
      branches.set(p.id, b);
      diff = true;
    }
  }
  if (diff) events.emit('change');
}
pollBranches();
setInterval(pollBranches, 4000);

// ---------- state ----------

let accounts = listAccounts();
setInterval(() => (accounts = listAccounts()), 60_000);

// ---------- when each project last had a chat ----------
// The newest transcript in the project's folder, across all accounts. Polled, not watched: cheap stats.

const lastChats = new Map<string, number>();
function pollLastChats() {
  let diff = false;
  for (const p of data.projects) {
    const t = lastChatAt(p.path);
    if ((lastChats.get(p.id) ?? null) !== t) {
      if (t === null) lastChats.delete(p.id);
      else lastChats.set(p.id, t);
      diff = true;
    }
  }
  if (diff) events.emit('change');
}
// Projects that were only added, never used, don't count as "just used".
for (const p of data.projects) if (p.lastUsed === p.addedAt) p.lastUsed = 0;
// Once: "last used" stamps from before 2026-11-05 also counted the terminal's automatic answers and
// resumed tabs. Real activity comes from the chats themselves, so those stamps start over.
if (!data.activityV2) {
  for (const p of data.projects) p.lastUsed = 0;
  data.activityV2 = true;
  save();
}
pollLastChats();

// "Freie Chats" (chats without a project, in the home folder) exists from the start, so its entry in
// the sidebar can open it right away. On the server too: there it is the place for quick chats.
if (!data.projects.some((p) => p.free)) {
  data.projects.push({ id: newId(), path: HOME, name: 'Freie Chats', free: true, addedAt: Date.now(), lastUsed: 0 });
  save();
}
setInterval(pollLastChats, 20_000);

function projectView(p: (typeof data.projects)[number]): ProjectView {
  return {
    id: p.id,
    path: p.path,
    name: p.name ?? null,
    displayName: p.name || path.basename(p.path) || p.path,
    pinned: !!p.pinned,
    lastUsed: p.lastUsed,
    lastChat: lastChats.get(p.id) ?? null,
    branch: branches.get(p.id) ?? null,
    exists: fs.existsSync(p.path),
    account: p.account ?? null,
    group: p.group ?? null,
    icon: p.icon ?? (projectIcon(p.path) ? 'auto' : null),
    free: !!p.free,
  };
}

function state(): AppState {
  return {
    projects: data.projects.map(projectView),
    tabs: data.tabs.map((r) => tabs.get(r.id)?.view()).filter((t) => !!t),
    accounts,
    groupIcons: { ...(data.groupIcons ?? {}) },
    usage: usageViews(),
    remote: remoteView(),
    server: serverView(),
    serverMode: SERVER_MODE,
    nola: NOLA_AVAILABLE,
    agy: AGY_AVAILABLE,
    laptopUrl: SERVER_MODE ? data.laptopUrl ?? null : null,
    laptop: laptopView(),
    sep: path.sep,
    home: HOME,
    version: version(),
    update: { ...update },
    setup: !settings().setupDone,
    release: release(),
  };
}

function release(): AppState['release'] {
  const u = updateView();
  if (u.ready) return { latest: u.latest, ready: u.ready };
  return updatable() ? { latest: u.latest, ready: null } : null;
}

// ---------- settings page ----------

let claudeVersion: string | null = null;
function readClaudeVersion() {
  execFile(claudeBin(), ['--version'], { timeout: 10_000, windowsHide: true }, (err, out) => {
    claudeVersion = err ? null : String(out).trim().split(/\s+/)[0] || null;
  });
}
readClaudeVersion();

function settingsView(): SettingsView {
  const fixed: SettingsView['fixed'] = {};
  for (const k of envFixed()) fixed[k] = ENV[k];
  return {
    values: { ...savedSettings(), autostart: autostartOn() },
    fixed,
    restart: needsRestart(),
    found: {
      claude: ((f) => (fs.existsSync(f) ? f : null))(findClaude()),
      claudeVersion: fs.existsSync(claudeBin()) ? claudeVersion : null,
      shell: FOUND_SHELL,
      tailscale: FOUND_TAILSCALE ?? null,
      agy: fs.existsSync(FOUND_AGY) ? FOUND_AGY : null,
      nolaHelper: FOUND_NOLA,
      taskDir: FOUND_TASK_DIR,
    },
    platform: process.platform,
    dataDir: DATA_DIR,
    update: updateView(),
  };
}

// ---------- security ----------
// Only our own page may talk to us. Without this, any website open in the browser could start shells.

const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
if (DEV) {
  for (const h of [HOST, 'localhost']) {
    allowedHosts.add(`${h}:${DEV_WEB_PORT}`);
    allowedOrigins.add(`http://${h}:${DEV_WEB_PORT}`);
  }
}

function trusted(req: http.IncomingMessage, needOrigin: boolean) {
  if (isRemote(req)) return remoteAllowed(req, needOrigin);
  if (!allowedHosts.has(String(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (origin) return allowedOrigins.has(origin);
  return !needOrigin;
}

// ---------- http ----------

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 2_000_000): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('too large');
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = path.normalize(path.join(WEB_DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(WEB_DIST)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Otterdeck läuft. Die Oberfläche fehlt noch: npm run build');
  }
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

// A project's own icon, if it has one in a usual place.
const ICON_CANDIDATES = [
  'icon.svg', 'icon.png', 'logo.svg', 'logo.png', 'favicon.svg', 'favicon.png',
  'public/icon.svg', 'public/icon.png', 'public/favicon.svg', 'public/favicon.png', 'public/logo.svg', 'public/logo.png',
  'public/apple-touch-icon.png', 'web/public/icon.svg', 'static/favicon.svg', 'static/favicon.png',
  'src/app/icon.svg', 'src/app/icon.png', 'app/icon.svg', 'app/icon.png',
  'assets/icon.png', 'assets/logo.png', 'build/icon.png',
];
const iconCache = new Map<string, { at: number; file: string | null }>();
const ICON_TYPES: Record<string, string> = {
  'image/svg+xml': '.svg', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
};

/** Stores an uploaded icon under a fresh name (the name doubles as version) and removes the old one. */
async function storeIcon(req: http.IncomingMessage, old: string | undefined): Promise<string> {
  const ext = ICON_TYPES[String(req.headers['content-type'] ?? '').split(';')[0].trim()];
  if (!ext) throw new Error('Bitte ein Bild wählen (SVG, PNG, JPG, WebP, ICO).');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 3_000_000) throw new Error('Das Bild ist größer als 3 MB.');
    chunks.push(c);
  }
  const name = newId() + ext;
  fs.writeFileSync(path.join(ICON_DIR, name), Buffer.concat(chunks));
  dropIcon(old);
  return name;
}
function dropIcon(name: string | undefined) {
  if (name) fs.rmSync(path.join(ICON_DIR, path.basename(name)), { force: true });
}
function sendIcon(res: http.ServerResponse, file: string | null) {
  if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'no icon' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'image/png', 'cache-control': 'max-age=86400' });
  fs.createReadStream(file).pipe(res);
}

function projectIcon(dir: string): string | null {
  const hit = iconCache.get(dir);
  if (hit && Date.now() - hit.at < 60_000) return hit.file;
  let file: string | null = null;
  for (const c of ICON_CANDIDATES) {
    const f = path.join(dir, c);
    try {
      const st = fs.statSync(f);
      if (st.isFile() && st.size < 2_000_000) {
        file = f;
        break;
      }
    } catch {}
  }
  iconCache.set(dir, { at: Date.now(), file });
  return file;
}

function listDirs(input: string) {
  const win = path.sep === '\\';
  let raw = win ? input.trim().replace(/\//g, '\\') : input.trim();
  if (!win && raw.startsWith('~')) raw = HOME + raw.slice(1);
  if (win ? !/^[a-zA-Z]:/.test(raw) : !raw.startsWith('/')) return [];
  const endsWithSep = raw.endsWith(path.sep);
  const parent = endsWithSep ? raw : path.dirname(raw);
  const prefix = endsWithSep ? '' : path.basename(raw).toLowerCase();
  try {
    return fs
      .readdirSync(win && parent.length === 2 ? parent + '\\' : parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/^[.$]/.test(e.name) && e.name.toLowerCase().startsWith(prefix))
      .slice(0, 30)
      .map((e) => path.join(parent, e.name));
  } catch {
    return [];
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  try {
    // Hook events come from our own child processes and carry the token instead of an origin.
    // Usage limits from a tab's status line (hook/otter-status.mjs)
    if (url.pathname === '/api/usage' && method === 'POST') {
      if (req.headers['x-otter-token'] !== HOOK_TOKEN) return json(res, 403, { error: 'token' });
      const { tab, rate_limits, model } = await readBody(req);
      const t = tabs.get(tab);
      const account = t?.view().account;
      if (account && rate_limits && recordUsage(account, rate_limits)) events.emit('change');
      if (t && typeof model === 'string' && model && model !== t.modelLabel) {
        t.modelLabel = model.slice(0, 60);
        events.emit('change');
      }
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/hook' && method === 'POST') {
      if (req.headers['x-otter-token'] !== HOOK_TOKEN) return json(res, 403, { error: 'token' });
      const { tab, event, payload } = await readBody(req);
      tabs.get(tab)?.hook(event, payload ?? {});
      return json(res, 200, { ok: true });
    }

    if (parts[0] !== 'api') {
      if (!trusted(req, false)) return json(res, 403, { error: 'host' });
      return serveStatic(req, res);
    }

    if (!trusted(req, method !== 'GET')) return json(res, 403, { error: 'origin' });

    if (url.pathname === '/api/ping') return json(res, 200, { app: 'otterdeck' });
    if (url.pathname === '/api/models') return json(res, 200, await models());
    // ---------- server side of "Auf Server abgeben" (handoff.ts) ----------
    if (url.pathname === '/api/server/info') return json(res, 200, serverInfo());
    if (url.pathname === '/api/server/laptop' && method === 'POST') {
      if (!SERVER_MODE) return json(res, 400, { error: 'Nur auf dem Server.' });
      const u = String((await readBody(req)).url ?? '').replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9.-]+\.ts\.net(:\d+)?$/i.test(u)) return json(res, 400, { error: 'Keine Tailscale-Adresse.' });
      if (data.laptopUrl !== u) {
        data.laptopUrl = u;
        save();
        events.emit('change');
        pollLaptopNow(() => events.emit('change'));
      }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/server/token' && method === 'POST') {
      if (!SERVER_MODE) return json(res, 400, { error: 'Nur auf dem Server.' });
      try {
        storeToken(String((await readBody(req)).token ?? '').trim());
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/handoff/upload' && method === 'POST') {
      if (!SERVER_MODE) return json(res, 400, { error: 'Nur auf dem Server.' });
      try {
        const size = await receiveUpload(req, url.searchParams.get('id') ?? '', url.searchParams.get('kind') ?? '');
        return json(res, 200, { ok: true, size });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === '/api/handoff/start' && method === 'POST') {
      if (!SERVER_MODE) return json(res, 400, { error: 'Nur auf dem Server.' });
      try {
        const r = await startTask(await readBody(req));
        events.emit('change');
        return json(res, 200, r);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (parts[1] === 'handoff' && parts[2] && parts[3]) {
      const id = parts[2];
      try {
        if (parts[3] === 'result' && method === 'GET') {
          const { file, done } = await resultBundle(id);
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-otter-done': done });
          return fs.createReadStream(file).pipe(res);
        }
        if (parts[3] === 'transcript' && method === 'GET') {
          const t = resultTranscript(id);
          if (!t) return json(res, 404, { error: 'Kein Chat.' });
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-otter-session': t.sessionId });
          return fs.createReadStream(t.file).pipe(res);
        }
        if (parts[3] === 'close' && method === 'POST') {
          closeTask(id);
          events.emit('change');
          return json(res, 200, { ok: true });
        }
      } catch (err) {
        return json(res, 409, { error: (err as Error).message });
      }
    }

    // ---------- NOLA (nola.ts) ----------
    if (parts[1] === 'nola') {
      try {
        if (parts[2] === 'search') {
          const list = data.projects.map((p) => ({ id: p.id, name: p.name ?? '', group: p.group ?? null, folder: path.basename(p.path), nolaCard: p.nolaCard }));
          const found = await searchTasks(url.searchParams.get('q') ?? '');
          return json(res, 200, found.map((t) => ({ ...t, projectId: projectFor(t, list)?.id ?? null })));
        }
        if (parts[2] === 'project' && parts[3]) {
          const p = data.projects.find((x) => x.id === parts[3]);
          if (!p) return json(res, 404, { error: 'Projekt fehlt.' });
          if (method === 'PATCH') {
            const card = Number((await readBody(req)).card);
            p.nolaCard = card > 0 ? card : undefined;
            save();
          }
          return json(res, 200, await projectTasks({ name: p.name ?? '', group: p.group ?? null, folder: path.basename(p.path), nolaCard: p.nolaCard }, url.searchParams.has('fresh')));
        }
        if (parts[2] === 'task' && parts[3]) {
          const id = Number(parts[3]);
          if (!parts[4]) return json(res, 200, await taskDetail(id));
          if (parts[4] === 'subtask' && method === 'POST') {
            const body = await readBody(req);
            await setSubtask(id, Number(body.index), !!body.checked);
            return json(res, 200, await taskDetail(id));
          }
          if (parts[4] === 'move' && method === 'POST') {
            const to = String((await readBody(req)).to);
            await moveTask(id, to === 'done' ? 'done' : to === 'doing' ? 'doing' : 'open');
            return json(res, 200, await taskDetail(id));
          }
          if (parts[4] === 'claude' && method === 'POST') {
            const projectId = String((await readBody(req)).projectId);
            const p = data.projects.find((x) => x.id === projectId);
            if (!p) return json(res, 404, { error: 'Projekt fehlt.' });
            const { prompt } = await claudePrompt(id);
            const tab = createTab(p.id, 'claude', undefined, prompt);
            return json(res, 200, { tabId: tab.rec.id });
          }
        }
        return json(res, 404, { error: 'not found' });
      } catch (err) {
        return json(res, 502, { error: (err as Error).message });
      }
    }

    // ---------- laptop side ----------
    if (url.pathname === '/api/server' && method === 'POST') {
      try {
        const info = await setServer(String((await readBody(req)).url ?? ''));
        events.emit('change');
        return json(res, 200, info);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === '/api/server/connect' && method === 'POST') {
      const body = await readBody(req);
      const projectId = String(body.projectId ?? data.projects[0]?.id ?? '');
      if (!data.projects.some((p) => p.id === projectId)) return json(res, 400, { error: 'Projekt fehlt.' });
      const tabId = connectToken(projectId, (err) => {
        events.emit('change');
        events.emit('toast', err ? `Server verbinden ging nicht: ${err.message}` : 'Server verbunden. Claude meldet sich dort jetzt mit dem Schlüssel an.');
      });
      return json(res, 200, { tabId });
    }
    if (url.pathname === '/api/handoffs/return' && method === 'POST') {
      try {
        const r = await bringBack(String((await readBody(req)).id ?? ''));
        events.emit('change');
        return json(res, 200, r);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    // /api/remote – phone access over Tailscale (turning it on only from the PC itself)
    if (url.pathname === '/api/remote') {
      if (method === 'GET') {
        await refreshRemote();
        return json(res, 200, remoteView());
      }
      const body = await readBody(req);
      if (body.enabled && isRemote(req)) return json(res, 403, { error: 'Nur am PC einschaltbar.' });
      try {
        await setRemote(!!body.enabled);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      events.emit('change');
      return json(res, 200, remoteView());
    }
    if (url.pathname === '/api/restart' && method === 'POST') {
      const body = await readBody(req);
      const cont = typeof body.tab === 'string' && typeof body.prompt === 'string' ? { tab: body.tab, prompt: body.prompt } : undefined;
      requestRestart(cont, !!body.now);
      return json(res, 200, { ok: true });
    }
    // /api/settings – the settings page and the setup at first start
    if (url.pathname === '/api/settings') {
      if (method === 'POST') {
        const body = await readBody(req);
        try {
          if (typeof body.autostart === 'boolean') await setAutostart(body.autostart);
        } catch (err) {
          return json(res, 400, { error: 'Autostart: ' + (err as Error).message });
        }
        updateSettings(body);
        if (body.recheck) readClaudeVersion();
        events.emit('change');
      }
      return json(res, 200, settingsView());
    }
    if (url.pathname === '/api/updates/check' && method === 'POST') {
      await checkForUpdate();
      events.emit('change');
      return json(res, 200, settingsView());
    }
    if (url.pathname === '/api/updates/install' && method === 'POST') {
      try {
        await installUpdate();
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      json(res, 200, settingsView());
      // Starts the new version as soon as no Claude is in the middle of something (after the answer).
      return void setTimeout(() => requestRestart(), 300);
    }
    if (url.pathname === '/api/shutdown' && method === 'POST') {
      json(res, 200, { ok: true });
      return setTimeout(shutdown, 100);
    }
    if (url.pathname === '/api/state') return json(res, 200, { ...state(), isRemote: isRemote(req) });
    if (url.pathname === '/api/fs/dirs') return json(res, 200, listDirs(url.searchParams.get('path') ?? ''));
    if (url.pathname === '/api/suggestions')
      return json(res, 200, suggestions(data.projects.map((p) => p.path)));

    // /api/uploads – a file or picture from the chat box, stored where every Claude tab may read it
    if (url.pathname === '/api/uploads' && method === 'POST') {
      const original = path.basename(url.searchParams.get('name') || 'datei');
      // No spaces or odd characters: the path goes into a message as plain text.
      const safe =
        original
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '') // ä → a, so the name stays readable
          .replace(/[^\w.-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(-80) || 'datei';
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(UPLOAD_DIR, day);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${newId()}-${safe}`);
      let size = 0;
      const out = fs.createWriteStream(file);
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 30 * 1024 * 1024) throw new Error('Die Datei ist größer als 30 MB.');
          out.write(chunk);
        }
      } catch (err) {
        out.destroy();
        fs.rmSync(file, { force: true });
        return json(res, 413, { error: (err as Error).message });
      }
      await new Promise((r) => out.end(r));
      return json(res, 200, { path: file, name: original, size });
    }
    if (url.pathname === '/api/uploads/file' && method === 'GET') {
      // Thumbnails of what you attached; only files inside the upload folder.
      const abs = safeJoin(UPLOAD_DIR, path.relative(UPLOAD_DIR, url.searchParams.get('path') ?? ''));
      const ext = path.extname(abs).toLowerCase();
      const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
      if (!type || !fs.existsSync(abs)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' });
      return fs.createReadStream(abs).pipe(res);
    }

    // /api/chats – every recent chat; attach = copy one into a project (and optionally open it)
    if (url.pathname === '/api/chats' && method === 'GET') return json(res, 200, allChats(data.projects));
    if (url.pathname === '/api/chats/attach' && method === 'POST') {
      const body = await readBody(req);
      const p = data.projects.find((x) => x.id === body.projectId);
      if (!p) return json(res, 400, { error: 'Projekt nicht gefunden.' });
      const result = attachChat(
        { account: String(body.account), dir: String(body.dir), sessionId: String(body.sessionId) },
        p.path,
      );
      let tabId: string | null = null;
      if (body.open) {
        // Already open in this project? Then just show that tab.
        const existing = [...tabs.values()].find((t) => t.rec.projectId === p.id && t.rec.claudeSessionId === body.sessionId);
        tabId = existing ? existing.rec.id : createTab(p.id, 'claude', String(body.sessionId), undefined, String(body.account)).rec.id;
      }
      return json(res, 200, { ...result, tabId });
    }

    // /api/groups/icon?name=… – a group's own icon (GET, PUT with the picture as body, DELETE)
    if (url.pathname === '/api/groups/icon') {
      const name = String(url.searchParams.get('name') ?? '').trim();
      const gi = (data.groupIcons ??= {});
      if (method === 'GET') return sendIcon(res, gi[name] ? path.join(ICON_DIR, path.basename(gi[name])) : null);
      if (!name) return json(res, 400, { error: 'name fehlt' });
      if (method === 'PUT') {
        try {
          gi[name] = await storeIcon(req, gi[name]);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      } else if (method === 'DELETE') {
        dropIcon(gi[name]);
        delete gi[name];
      }
      save();
      events.emit('change');
      return json(res, 200, { ok: true });
    }

    // /api/groups – rename a group (to = name) or dissolve it (to = empty): applies to all its projects
    if (url.pathname === '/api/groups' && method === 'POST') {
      const body = await readBody(req);
      const from = String(body.from ?? '').trim();
      const to = String(body.to ?? '').trim();
      for (const p of data.projects) if (p.group === from) p.group = to || undefined;
      const gi = (data.groupIcons ??= {});
      if (gi[from]) {
        if (to && !gi[to]) gi[to] = gi[from];
        else dropIcon(gi[from]);
        delete gi[from];
      }
      save();
      events.emit('change');
      return json(res, 200, { ok: true });
    }

    // /api/projects
    // "Freie Chats": one fixed project in the home folder, created on first use.
    if (url.pathname === '/api/projects/free' && method === 'POST') {
      let free = data.projects.find((p) => p.free);
      if (!free) {
        free = { id: newId(), path: HOME, name: 'Freie Chats', free: true, addedAt: Date.now(), lastUsed: 0 };
        data.projects.push(free);
        save();
        events.emit('change');
      }
      return json(res, 200, { id: free.id });
    }

    if (parts[1] === 'projects' && !parts[2] && method === 'POST') {
      const body = await readBody(req);
      // From GitHub (or any git address): clone into the chosen place, then add it like a folder.
      if (body.clone) {
        let src = String(body.url ?? '').trim().replace(/\/+$/, '');
        if (/^[\w.-]+\/[\w.-]+$/.test(src)) src = `https://github.com/${src}.git`; // owner/repo
        if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(src)) return json(res, 400, { error: 'Bitte eine Repo-Adresse wie https://github.com/name/repo oder name/repo.' });
        const parent = path.resolve(String(body.parent ?? '').trim());
        if (!body.parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return json(res, 400, { error: 'Den Ort gibt es nicht.' });
        const name = String(body.name ?? '').trim() || src.split(/[/:]/).pop()!.replace(/\.git$/, '');
        if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /^\.+$/.test(name)) return json(res, 400, { error: 'Ungültiger Ordnername.' });
        const target = path.join(parent, name);
        if (fs.existsSync(target)) return json(res, 400, { error: `„${name}“ gibt es dort schon. Füg den Ordner unter „Vorhandener Ordner“ hinzu.` });
        try {
          await new Promise<void>((resolve, reject) =>
            execFile(
              'git',
              ['clone', '-q', src, target],
              // Never wait for a password prompt that nobody sees: fail with a message instead.
              { timeout: 10 * 60_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } },
              (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop())) : resolve()),
            ),
          );
        } catch (err) {
          fs.rmSync(target, { recursive: true, force: true });
          const msg = (err as Error).message;
          return json(res, 400, {
            error: /could not read Username|Authentication|Permission denied|not found|Repository not found/i.test(msg)
              ? `Klonen ging nicht: kein Zugriff auf das Repo. Auf diesem Rechner ist Git für GitHub nicht angemeldet (${msg}).`
              : `Klonen ging nicht: ${msg}`,
          });
        }
        body.path = target;
      }
      // A new project: create its folder first (and optionally a git repository).
      if (body.create) {
        const name = String(body.name ?? '').trim();
        const parent = path.resolve(String(body.parent ?? '').trim());
        if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /^\.+$/.test(name) || name.length > 100)
          return json(res, 400, { error: 'Bitte einen gültigen Ordnernamen (ohne \\ / : * ? " < > |).' });
        if (!body.parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory())
          return json(res, 400, { error: 'Den Ort gibt es nicht.' });
        const target = path.join(parent, name);
        if (fs.existsSync(target)) return json(res, 400, { error: `„${name}“ gibt es dort schon. Füg den Ordner unter „Vorhandener Ordner“ hinzu.` });
        fs.mkdirSync(target);
        if (body.git) {
          try {
            await new Promise<void>((resolve, reject) =>
              execFile('git', ['init', '-q', '-b', 'main'], { cwd: target, windowsHide: true }, (err) => (err ? reject(err) : resolve())),
            );
          } catch {}
        }
        body.path = target;
      }
      const dir = path.resolve(String(body.path ?? '').trim());
      if (!body.path || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        return json(res, 400, { error: 'Diesen Ordner gibt es nicht.' });
      const existing = data.projects.find((p) => samePath(p.path, dir));
      if (existing) return json(res, 200, { id: existing.id });
      const now = Date.now();
      // Adding or creating a project here is using it: it goes to the top ("Aktiv"). Bulk imports
      // (quiet: true) keep lastUsed 0, so old folders don't push ahead of real activity.
      const rec = { id: newId(), path: dir, addedAt: now, lastUsed: body.quiet ? 0 : now };
      data.projects.push(rec);
      branches.set(rec.id, readBranch(dir));
      save();
      events.emit('change');
      return json(res, 200, { id: rec.id });
    }

    if (parts[1] === 'projects' && parts[2]) {
      const p = data.projects.find((x) => x.id === parts[2]);
      if (!p) return json(res, 404, { error: 'not found' });
      if (!parts[3] && method === 'PATCH') {
        const body = await readBody(req);
        if ('name' in body) p.name = String(body.name ?? '').trim() || undefined;
        if ('pinned' in body) p.pinned = !!body.pinned || undefined;
        if ('account' in body) p.account = body.account || undefined;
        if ('group' in body) p.group = String(body.group ?? '').trim() || undefined;
        save();
        events.emit('change');
        return json(res, 200, { ok: true });
      }
      if (!parts[3] && method === 'DELETE') {
        for (const t of [...tabs.values()]) if (t.rec.projectId === p.id) closeTab(t.rec.id);
        data.projects = data.projects.filter((x) => x.id !== p.id);
        save();
        events.emit('change');
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'icon') {
        if (method === 'PUT') {
          try {
            p.icon = await storeIcon(req, p.icon);
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
          save();
          events.emit('change');
          return json(res, 200, { ok: true });
        }
        if (method === 'DELETE') {
          dropIcon(p.icon);
          delete p.icon;
          save();
          events.emit('change');
          return json(res, 200, { ok: true });
        }
        return sendIcon(res, p.icon ? path.join(ICON_DIR, path.basename(p.icon)) : projectIcon(p.path));
      }
      if (parts[3] === 'changes') {
        keepWatching(p.id, p.path);
        const mode = url.searchParams.get('mode') === 'base' ? 'base' : 'head';
        return json(res, 200, await changes(p.path, mode));
      }
      if (parts[3] === 'diff') {
        const mode = url.searchParams.get('mode') === 'base' ? 'base' : 'head';
        return json(res, 200, await fileDiff(p.path, url.searchParams.get('path') ?? '', mode));
      }
      if (parts[3] === 'files') return json(res, 200, listDir(p.path, url.searchParams.get('path') ?? ''));
      if (parts[3] === 'file') return json(res, 200, readFile(p.path, url.searchParams.get('path') ?? ''));
      if (parts[3] === 'raw') {
        const abs = safeJoin(p.path, url.searchParams.get('path') ?? '');
        const ext = path.extname(abs).toLowerCase();
        const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] ?? TYPES[ext];
        // Only images are served raw; an HTML or SVG file from a project must not run as our page.
        if (!type?.startsWith('image/') || ext === '.svg') return json(res, 415, { error: 'Nur Bilder.' });
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        return fs.createReadStream(abs).pipe(res);
      }
      if (parts[3] === 'commands') {
        // The tab's own account decides which skills exist; fall back to the project's.
        const tab = tabs.get(url.searchParams.get('tab') ?? '');
        return json(res, 200, slashCommands(p.path, tab?.rec.account || p.account || DEFAULT_CLAUDE_DIR));
      }
      if (parts[3] === 'conversations')
        // Claude's and Antigravity's chats of this folder, newest first.
        return json(res, 200, [...conversations(p.path), ...(AGY_AVAILABLE ? agyConversations(p.path) : [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 9));
      if (parts[3] === 'reveal' && method === 'POST') {
        if (process.platform === 'win32') spawn('explorer.exe', [p.path], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }
    }

    // /api/tabs
    if (parts[1] === 'tabs' && !parts[2] && method === 'POST') {
      const body = await readBody(req);
      if (!data.projects.some((p) => p.id === body.projectId)) return json(res, 400, { error: 'project' });
      const kind = body.kind === 'shell' ? 'shell' : body.kind === 'agy' ? 'agy' : 'claude';
      const model = kind === 'shell' ? undefined : await validModel(kind, body.model);
      const effort = kind === 'claude' && typeof body.effort === 'string' && EFFORTS.has(body.effort) ? body.effort : undefined;
      if (kind === 'agy' && !AGY_AVAILABLE) return json(res, 400, { error: 'Die Antigravity-CLI (agy) ist nicht installiert.' });
      const tab = createTab(
        body.projectId,
        kind,
        typeof body.resume === 'string' ? body.resume : undefined,
        typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : undefined,
        // Only accounts that really exist on this computer.
        accounts.find((a) => typeof body.account === 'string' && a.dir.toLowerCase() === body.account.toLowerCase())?.dir,
        { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
      );
      return json(res, 200, { id: tab.rec.id });
    }
    if (parts[1] === 'tabs' && parts[2]) {
      const id = parts[2];
      if (!tabs.has(id)) return json(res, 404, { error: 'not found' });
      // Chat mit anderem Anbieter fortsetzen (continue.ts)
      if (parts[3] === 'continue' && method === 'POST') {
        const body = await readBody(req);
        const tab = tabs.get(id)!;
        const project = data.projects.find((p) => p.id === tab.rec.projectId);
        if (!project) return json(res, 404, { error: 'Projekt fehlt.' });
        const kind = body.provider === 'agy' ? 'agy' : 'claude';
        if (kind === 'agy' && !AGY_AVAILABLE) return json(res, 400, { error: 'Die Antigravity-CLI (agy) ist nicht installiert.' });
        try {
          const file = exportChat(tab, project.name || path.basename(project.path));
          const from = tab.rec.kind === 'agy' ? 'Antigravity' : 'Claude';
          const model = await validModel(kind, body.model);
          const effort = kind === 'claude' && typeof body.effort === 'string' && EFFORTS.has(body.effort) ? body.effort : undefined;
          const account = kind === 'claude' ? accounts.find((a) => typeof body.account === 'string' && a.dir.toLowerCase() === body.account.toLowerCase())?.dir : undefined;
          const next = createTab(project.id, kind, undefined, continuePrompt(file, from), account, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
          return json(res, 200, { id: next.rec.id, file });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }
      if (parts[3] === 'effort' && method === 'POST') {
        const level = String((await readBody(req)).effort ?? '');
        if (!EFFORTS.has(level)) return json(res, 400, { error: 'Diese Stufe gibt es nicht.' });
        try {
          await tabs.get(id)!.setEffort(level);
        } catch (err) {
          return json(res, 409, { error: (err as Error).message });
        }
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'model' && method === 'POST') {
        const tab = tabs.get(id)!;
        const provider = tab.rec.kind === 'agy' ? 'agy' : 'claude';
        const model = await validModel(provider, (await readBody(req)).model);
        if (!model) return json(res, 400, { error: 'Dieses Modell gibt es hier nicht.' });
        try {
          await tab.setModel(model);
        } catch (err) {
          return json(res, 409, { error: (err as Error).message });
        }
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'handoff' && method === 'POST') {
        const body = await readBody(req);
        try {
          const rec = await handOff(id, String(body.prompt ?? ''), body.gitName, body.gitEmail);
          events.emit('change');
          return json(res, 200, rec);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }
      if (!parts[3] && method === 'DELETE') {
        closeTab(id);
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'restart' && method === 'POST') {
        const body = await readBody(req);
        restartTab(id, !!body.fresh);
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'type' && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: 'Leere Nachricht.' });
        const ok = await tabs.get(id)!.type(text);
        return json(res, ok ? 200 : 409, ok ? { ok } : { error: 'Der Tab läuft gerade nicht.' });
      }
      if (parts[3] === 'screen') return json(res, 200, tabs.get(id)!.screen());
      if (parts[3] === 'mode' && method === 'POST') {
        const body = await readBody(req);
        const modes = ['default', 'acceptEdits', 'plan', 'auto', 'bypass'];
        if (!modes.includes(body.mode)) return json(res, 400, { error: 'Unbekannter Modus.' });
        const ok = await tabs.get(id)!.setMode(body.mode);
        return json(res, ok ? 200 : 409, ok ? { ok } : { error: 'Diesen Modus bietet Claude hier nicht an.' });
      }
      if (parts[3] === 'choose' && method === 'POST') {
        const body = await readBody(req);
        const ok = await tabs.get(id)!.choose(Number(body.n), typeof body.text === 'string' ? body.text : undefined);
        return json(res, ok ? 200 : 409, ok ? { ok } : { error: 'Gerade ist keine Frage offen.' });
      }
      // Several questions: switch to another one (or the review page).
      if (parts[3] === 'step' && method === 'POST') {
        const ok = await tabs.get(id)!.goStep(Number((await readBody(req)).to));
        return json(res, ok ? 200 : 409, ok ? { ok } : { error: 'Gerade gibt es keine Fragen zum Wechseln.' });
      }
      // The code from the sign-in page, typed into Claude's "Paste code here" field.
      if (parts[3] === 'login' && method === 'POST') {
        const code = String((await readBody(req)).code ?? '').trim();
        if (!/^[\w#.~-]{8,2000}$/.test(code)) return json(res, 400, { error: 'Das sieht nicht nach einem Anmelde-Code aus.' });
        const ok = tabs.get(id)!.loginCode(code);
        return json(res, ok ? 200 : 409, ok ? { ok } : { error: 'Claude wartet gerade nicht auf einen Code.' });
      }
      if (parts[3] === 'key' && method === 'POST') {
        const body = await readBody(req);
        const key = body.key === 'allow' ? 'allow' : body.key === 'deny' ? 'deny' : 'stop';
        const ok = tabs.get(id)!.key(key);
        return json(res, ok ? 200 : 409, ok ? { ok } : { error: 'Der Tab läuft gerade nicht.' });
      }
      if (parts[3] === 'send' && method === 'POST') {
        const body = await readBody(req);
        const ok = tabs.get(id)!.paste(String(body.text ?? ''), body.submit !== false, String(body.lead ?? ''));
        return json(res, ok ? 200 : 409, ok ? { ok } : { error: 'Der Tab läuft gerade nicht.' });
      }
      if (parts[3] === 'seen' && method === 'POST') {
        markSeen(id);
        return json(res, 200, { ok: true });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

// ---------- websockets ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const eventClients = new Set<WebSocket>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!trusted(req, true)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/ws/events') {
      eventClients.add(ws);
      const remote = isRemote(req);
      (ws as any).remote = remote;
      const untrack = remote ? trackDevice(req, () => events.emit('change')) : null;
      ws.send(JSON.stringify({ t: 'state', state: { ...state(), isRemote: remote } } satisfies EventMsg));
      ws.on('close', () => {
        eventClients.delete(ws);
        untrack?.();
      });
      return;
    }
    if (url.pathname === '/ws/chat') {
      const tab = tabs.get(url.searchParams.get('tab') ?? '');
      if (!tab || (tab.rec.kind !== 'claude' && tab.rec.kind !== 'agy')) return ws.close(4404, 'tab');
      tab.attachChat(ws);
      ws.on('close', () => tab.detachChat(ws));
      return;
    }
    if (url.pathname === '/ws/term') {
      const tab = tabs.get(url.searchParams.get('tab') ?? '');
      if (!tab) return ws.close(4404, 'tab');
      let attached = false;
      const attach = (cols: number, rows: number) => {
        if (attached) return;
        attached = true;
        tab.attach(ws, cols, rows);
      };
      // The client sends its size first, so the snapshot matches its screen.
      const fallback = setTimeout(() => attach(tab.cols, tab.rows), 800);
      ws.on('message', (raw) => {
        let msg: TermClientMsg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.t === 'resize') {
          if (!attached) {
            clearTimeout(fallback);
            attach(msg.cols, msg.rows);
          } else tab.resize(msg.cols, msg.rows);
        } else if (msg.t === 'in' && typeof msg.d === 'string') tab.input(msg.d);
      });
      ws.on('close', () => {
        clearTimeout(fallback);
        tab.detach(ws);
      });
      return;
    }
    ws.close();
  });
});

// Short messages for every window (e.g. "Server verbunden").
events.on('toast', (text: string) => {
  const s = JSON.stringify({ t: 'toast', text } satisfies EventMsg);
  for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send(s);
});

// Laptop: status of the tasks on the server, for the sidebar.
setInterval(() => pollServer(() => events.emit('change'), remoteView().url), 10_000).unref();
pollServer(() => events.emit('change'), remoteView().url);
startLaptopPoll(() => events.emit('change'));

let pushTimer: NodeJS.Timeout | null = null;
events.on('change', () => {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const st = state();
    const local = JSON.stringify({ t: 'state', state: st } satisfies EventMsg);
    const remote = JSON.stringify({ t: 'state', state: { ...st, isRemote: true } } satisfies EventMsg);
    for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send((ws as any).remote ? remote : local);
  }, 80);
});

// After a restart the old server may still hold the port for a moment.
let listenTries = process.env.OTTER_RESTARTED === '1' ? 60 : 0;
const listen = () => server.listen(PORT, HOST, () => console.log(`Otterdeck läuft auf http://${HOST}:${PORT}`));
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && listenTries-- > 0) return void setTimeout(listen, 250);
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} ist belegt. Läuft Otterdeck schon?`);
  else console.error(err);
  process.exit(1);
});
listen();

function shutdown() {
  flush();
  killAll();
  process.exit(0);
}

// ---------- restart into a new version ----------

watchForUpdates(() => events.emit('change'));
watchReleases(() => events.emit('change'));
let restartTimer: NodeJS.Timeout | null = null;

/**
 * Restarts as soon as no Claude is in the middle of a turn. With now = true right away: a Claude that is
 * still working gets interrupted, and after the restart it is told to carry on where it was.
 */
function requestRestart(cont?: { tab: string; prompt: string }, now = false) {
  if (cont) {
    const rec = data.tabs.find((t) => t.id === cont.tab);
    if (rec) {
      rec.pendingPrompt = cont.prompt;
      save();
    }
  }
  update.pending = true;
  events.emit('change');
  if (restartTimer) return;
  if (now) {
    for (const t of tabs.values())
      if (t.status === 'working' && t.rec.kind !== 'shell' && !t.rec.pendingPrompt) {
        t.rec.pendingPrompt =
          'Otterdeck wurde gerade neu gestartet (neue Version), mitten in deiner Arbeit. Mach bitte genau da weiter, wo du unterbrochen wurdest.';
      }
    save();
  }
  const tryNow = () => {
    if (!now && [...tabs.values()].some((t) => t.status === 'working')) return;
    if (restartTimer) clearInterval(restartTimer);
    console.log('Neustart in die neue Version …');
    respawn(() => {
      flush();
      killAll();
      server.close();
    });
  };
  restartTimer = setInterval(tryNow, 1000);
  tryNow();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
