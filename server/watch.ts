// Watches project folders while someone looks at their changes, and says when something changed.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

export const fileEvents = new EventEmitter(); // 'changed' (projectId)

const IDLE_MS = 10 * 60_000;
// Paths whose changes never matter for the changes panel.
const NOISE = /(^|[\\/])(node_modules|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.venv)([\\/]|$)|^\.git[\\/](objects|logs|lfs|hooks)[\\/]|\.git[\\/]index\.lock$|~$|\.swp$/i;

interface Watch {
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
  lastUsed: number;
}

const watches = new Map<string, Watch>();

/** Starts (or keeps alive) the watcher for a project. Call whenever its changes are requested. */
export function keepWatching(projectId: string, dir: string) {
  const w = watches.get(projectId);
  if (w) {
    w.lastUsed = Date.now();
    return;
  }
  try {
    const watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
      const file = String(name ?? '');
      if (file && NOISE.test(file)) return;
      const entry = watches.get(projectId);
      if (!entry || entry.timer) return;
      // Many writes arrive at once (saves, git operations); report once they settle.
      entry.timer = setTimeout(() => {
        entry.timer = null;
        fileEvents.emit('changed', projectId);
      }, 350);
    });
    watcher.on('error', () => stopWatching(projectId));
    watches.set(projectId, { watcher, timer: null, lastUsed: Date.now() });
  } catch {
    // Folder gone or not watchable: the panel still works, it just won't update by itself.
  }
}

export function stopWatching(projectId: string) {
  const w = watches.get(projectId);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  w.watcher.close();
  watches.delete(projectId);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, w] of watches) if (now - w.lastUsed > IDLE_MS) stopWatching(id);
}, 60_000).unref();
