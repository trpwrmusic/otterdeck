import { useEffect, useState } from 'react';
import { CloudUpload, ExternalLink, Server, Undo2 } from 'lucide-react';
import type { AppState, HandoffView, ServerView } from '../../shared/types';
import { api } from './api';
import { StatusMark } from './bits';

const toast = (text: string) => window.dispatchEvent(new CustomEvent('otter:toast', { detail: text }));

function ago(ms: number) {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 2) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  return h < 24 ? `vor ${h} Std.` : `vor ${Math.round(h / 24)} T.`;
}

const STATUS: Record<string, string> = {
  starting: 'startet …',
  ready: 'bereit',
  working: 'arbeitet',
  waiting: 'wartet auf dich',
  done: 'fertig',
  exited: 'beendet',
};

// ---------- side panel card: connect a server ----------

export function ServerCard({ server, projectId, onActivate }: { server: ServerView | null; projectId: string; onActivate: (tabId: string) => void }) {
  const [url, setUrl] = useState('https://mc-panel.tailabc123.ts.net:4747');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (!server)
    body = (
      <>
        <div className="usage-empty">Aufgaben an Claude auf einem Server abgeben und den Laptop zuklappen.</div>
        <input className="server-url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        <button className="copy-btn primary remote-on" disabled={busy} onClick={() => run(() => api.setServer(url))}>
          {busy ? 'Verbinde …' : 'Server eintragen'}
        </button>
      </>
    );
  else if (!server.tokenAt)
    body = (
      <>
        <div className="usage-empty">
          Einmal den Claude-Schlüssel einrichten (gilt ein Jahr): Es öffnet sich ein Tab, du bestätigst im Browser, Otterdeck schickt den Schlüssel an den Server.
        </div>
        <button
          className="copy-btn primary remote-on"
          disabled={busy}
          onClick={() => run(async () => onActivate((await api.connectServer(projectId)).tabId))}
        >
          Claude-Schlüssel einrichten
        </button>
      </>
    );
  else {
    const days = Math.round((server.tokenAt + 365 * 864e5 - Date.now()) / 864e5);
    body = (
      <>
        <div className="usage-empty">
          {server.reachable === false ? 'Gerade nicht erreichbar' : 'Verbunden'} · Schlüssel noch {days} Tage
        </div>
        {days < 21 && (
          <button className="copy-btn remote-on" disabled={busy} onClick={() => run(async () => onActivate((await api.connectServer(projectId)).tabId))}>
            Schlüssel erneuern
          </button>
        )}
      </>
    );
  }

  return (
    <section className="usage-card" aria-label="Server">
      <div className="usage-head">
        <span className="usage-title">
          <Server size={14} /> Server
        </span>
        <span className={`usage-account${server?.reachable ? ' on' : ''}`}>{server ? new URL(server.url).hostname.split('.')[0] : 'keiner'}</span>
      </div>
      {body}
      {error && <div className="remote-error">{error}</div>}
    </section>
  );
}

// ---------- dialog: hand a Claude tab to the server ----------

export function HandoffDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.handOff(tabId, prompt.trim());
      toast('Auf dem Server. Du kannst den Laptop jetzt zuklappen.');
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="dialog-scrim" onClick={() => !busy && onClose()}>
      <div className="dialog handoff-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Auf Server abgeben">
        <div className="dialog-title">
          <CloudUpload size={16} /> Auf Server abgeben
        </div>
        <div className="usage-empty">
          Code (auch nicht Committetes) und dieser Chat gehen an den Server. Claude macht dort weiter, hier stoppt der Tab. Mit „Zurückholen“ kommt alles wieder.
        </div>
        <textarea
          autoFocus
          rows={4}
          placeholder="Was soll Claude auf dem Server erledigen? (leer = einfach weitermachen)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
        {error && <div className="remote-error">{error}</div>}
        <div className="dialog-actions">
          <button className="copy-btn" disabled={busy} onClick={onClose}>
            Abbrechen
          </button>
          <button className="copy-btn primary" disabled={busy} onClick={submit}>
            {busy ? 'Packe ein …' : 'Abgeben'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- sidebar: tasks running on the server ----------

function HandoffRow({ h, state, onOpened }: { h: HandoffView; state: AppState; onOpened: (tabId: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const project = state.projects.find((p) => p.id === h.projectId);
  const attention = h.status === 'working' || h.status === 'waiting' || h.status === 'done' ? h.status : null;
  const back = async () => {
    setBusy(true);
    try {
      const r = await api.bringBack(h.id);
      toast(r.conflict ? `Zurückgeholt, aber mit Konflikten. Das Ergebnis liegt auch im Branch ${r.branch}.` : 'Zurückgeholt. Die Änderungen stehen unter „Änderungen“.');
      onOpened(r.tabId);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row handoff-row" title={h.prompt || h.title}>
      <span className="handoff-icon">
        <Server size={14} />
      </span>
      <div className="row-text">
        <div className="row-name">{h.title}</div>
        <div className={`row-line${h.status === 'waiting' ? ' waiting' : ''}`}>
          {project?.displayName ?? ''} · {h.status ? STATUS[h.status] ?? h.status : 'Server nicht erreichbar'} · {ago(h.createdAt)}
        </div>
      </div>
      <div className="row-mark handoff-actions">
        {attention && <StatusMark attention={attention} />}
        <button className="icon-btn" title="Auf dem Server öffnen" onClick={() => state.server && window.open(state.server.url, '_blank', 'noopener')}>
          <ExternalLink size={14} />
        </button>
        <button className="icon-btn" title="Zurückholen" disabled={busy || h.status === 'working'} onClick={back}>
          <Undo2 size={14} />
        </button>
      </div>
    </div>
  );
}

export function ServerTasks({ state, onOpened }: { state: AppState; onOpened: (projectId: string, tabId: string | null) => void }) {
  const list = state.server?.handoffs ?? [];
  if (!list.length) return null;
  return (
    <div className="section server-tasks">
      <div className="section-title">Auf dem Server</div>
      {list.map((h) => (
        <HandoffRow key={h.id} h={h} state={state} onOpened={(tabId) => onOpened(h.projectId, tabId)} />
      ))}
    </div>
  );
}
