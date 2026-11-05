import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppState, EventMsg, ProjectView, TermClientMsg } from '../shared/types.ts';
import { DEFAULT_CLAUDE_DIR, DEV, DEV_WEB_PORT, HOOK_TOKEN, HOST, PORT, WEB_DIST } from './config.ts';
import { allChats, attachChat, conversations, listAccounts, slashCommands, suggestions } from './claudeData.ts';
import { changes, fileDiff, listDir, readFile, safeJoin } from './git.ts';
import { writeHookSettings } from './hooks.ts';
import { shareMemory } from './memory.ts';
import { data, flush, newId, samePath, save } from './store.ts';
import { closeTab, createTab, events, killAll, markSeen, restartTab, resumePending, tabs } from './tabs.ts';
import { respawn, update, VERSION, watchForUpdates } from './update.ts';
import { fileEvents, keepWatching } from './watch.ts';

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

function projectView(p: (typeof data.projects)[number]): ProjectView {
  return {
    id: p.id,
    path: p.path,
    name: p.name ?? null,
    displayName: p.name || path.basename(p.path) || p.path,
    pinned: !!p.pinned,
    lastUsed: p.lastUsed,
    branch: branches.get(p.id) ?? null,
    exists: fs.existsSync(p.path),
    account: p.account ?? null,
  };
}

function state(): AppState {
  return {
    projects: data.projects.map(projectView),
    tabs: data.tabs.map((r) => tabs.get(r.id)?.view()).filter((t) => !!t),
    accounts,
    version: VERSION,
    update: { ...update },
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
  const raw = input.trim().replace(/\//g, '\\');
  if (!/^[a-zA-Z]:/.test(raw)) return [];
  const endsWithSep = raw.endsWith('\\');
  const parent = endsWithSep ? raw : path.dirname(raw);
  const prefix = endsWithSep ? '' : path.basename(raw).toLowerCase();
  try {
    return fs
      .readdirSync(parent.length === 2 ? parent + '\\' : parent, { withFileTypes: true })
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
    if (url.pathname === '/api/hook' && method === 'POST') {
      if (req.headers['x-otter-token'] !== HOOK_TOKEN) return json(res, 403, { error: 'token' });
      const { tab, event, payload } = await readBody(req);
      tabs.get(tab)?.hook(event, payload ?? {});
      return json(res, 200, { ok: true });
    }

    if (parts[0] !== 'api') {
      if (!allowedHosts.has(String(req.headers.host))) return json(res, 403, { error: 'host' });
      return serveStatic(req, res);
    }

    if (!trusted(req, method !== 'GET')) return json(res, 403, { error: 'origin' });

    if (url.pathname === '/api/ping') return json(res, 200, { app: 'otterdeck' });
    if (url.pathname === '/api/restart' && method === 'POST') {
      const body = await readBody(req);
      const cont = typeof body.tab === 'string' && typeof body.prompt === 'string' ? { tab: body.tab, prompt: body.prompt } : undefined;
      requestRestart(cont);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/shutdown' && method === 'POST') {
      json(res, 200, { ok: true });
      return setTimeout(shutdown, 100);
    }
    if (url.pathname === '/api/state') return json(res, 200, state());
    if (url.pathname === '/api/fs/dirs') return json(res, 200, listDirs(url.searchParams.get('path') ?? ''));
    if (url.pathname === '/api/suggestions')
      return json(res, 200, suggestions(data.projects.map((p) => p.path)));

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

    // /api/projects
    if (parts[1] === 'projects' && !parts[2] && method === 'POST') {
      const body = await readBody(req);
      const dir = path.resolve(String(body.path ?? '').trim());
      if (!body.path || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        return json(res, 400, { error: 'Diesen Ordner gibt es nicht.' });
      const existing = data.projects.find((p) => samePath(p.path, dir));
      if (existing) return json(res, 200, { id: existing.id });
      const now = Date.now();
      const rec = { id: newId(), path: dir, addedAt: now, lastUsed: now };
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
        const icon = projectIcon(p.path);
        if (!icon) return json(res, 404, { error: 'no icon' });
        res.writeHead(200, { 'content-type': TYPES[path.extname(icon)] ?? 'image/png', 'cache-control': 'max-age=300' });
        return fs.createReadStream(icon).pipe(res);
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
        return json(res, 200, conversations(p.path));
      if (parts[3] === 'reveal' && method === 'POST') {
        spawn('explorer.exe', [p.path], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }
    }

    // /api/tabs
    if (parts[1] === 'tabs' && !parts[2] && method === 'POST') {
      const body = await readBody(req);
      if (!data.projects.some((p) => p.id === body.projectId)) return json(res, 400, { error: 'project' });
      const kind = body.kind === 'shell' ? 'shell' : 'claude';
      const tab = createTab(
        body.projectId,
        kind,
        typeof body.resume === 'string' ? body.resume : undefined,
        typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : undefined,
        // Only accounts that really exist on this computer.
        accounts.find((a) => typeof body.account === 'string' && a.dir.toLowerCase() === body.account.toLowerCase())?.dir,
      );
      return json(res, 200, { id: tab.rec.id });
    }
    if (parts[1] === 'tabs' && parts[2]) {
      const id = parts[2];
      if (!tabs.has(id)) return json(res, 404, { error: 'not found' });
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
      if (parts[3] === 'choose' && method === 'POST') {
        const body = await readBody(req);
        const ok = await tabs.get(id)!.choose(Number(body.n), typeof body.text === 'string' ? body.text : undefined);
        return json(res, ok ? 200 : 409, ok ? { ok } : { error: 'Gerade ist keine Frage offen.' });
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
      ws.send(JSON.stringify({ t: 'state', state: state() } satisfies EventMsg));
      ws.on('close', () => eventClients.delete(ws));
      return;
    }
    if (url.pathname === '/ws/chat') {
      const tab = tabs.get(url.searchParams.get('tab') ?? '');
      if (!tab || tab.rec.kind !== 'claude') return ws.close(4404, 'tab');
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

let pushTimer: NodeJS.Timeout | null = null;
events.on('change', () => {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const s = JSON.stringify({ t: 'state', state: state() } satisfies EventMsg);
    for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send(s);
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
let restartTimer: NodeJS.Timeout | null = null;

/** Restarts as soon as no Claude is in the middle of a turn. */
function requestRestart(cont?: { tab: string; prompt: string }) {
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
  const tryNow = () => {
    if ([...tabs.values()].some((t) => t.status === 'working')) return;
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
