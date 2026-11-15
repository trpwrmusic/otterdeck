import { useEffect, useState } from 'react';
import { CloudUpload, ExternalLink, Laptop, Server, Undo2 } from 'lucide-react';
import type { AppState, HandoffView, ServerView } from '../../shared/types';
import { api, usePersisted } from './api';
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
  const [unfolded, setUnfolded] = usePersisted('otter.card.server', false);
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

  // Folded to one line once everything is set up; open while there is a step to do.
  const folded = !unfolded && !!server?.tokenAt && !error && server.reachable !== false && Math.round((server.tokenAt + 365 * 864e5 - Date.now()) / 864e5) >= 21;
  return (
    <section className={`usage-card fold${folded ? ' folded' : ''}`} aria-label="Server">
      <div className="usage-head" role="button" tabIndex={0} onClick={() => setUnfolded(!unfolded)} title={folded ? 'Aufklappen' : 'Einklappen'}>
        <span className="usage-title">
          <Server size={14} /> Server
        </span>
        <span className={`usage-account${server?.reachable ? ' on' : ''}`}>{server ? new URL(server.url).hostname.split('.')[0] : 'keiner'}</span>
      </div>
      {!folded && body}
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

// ---------- sidebar on the server: the laptop and its projects ----------

/** Server mode: is the laptop on, and what are its sessions doing? A tap opens the project there. */
export function LaptopSection({ state }: { state: AppState }) {
  const [all, setAll] = usePersisted('otter.laptopAll', false);
  const lp = state.laptop;
  if (!lp) return null;
  const list = all ? lp.projects : lp.projects.slice(0, 5);
  const off = lp.online === false;
  return (
    <div className={`section laptop-section${off ? ' off' : ''}`}>
      <div className="section-title laptop-title">
        <span>Laptop</span>
        <span className={`laptop-state${lp.online ? ' on' : ''}`}>
          {lp.online === null ? 'prüfe …' : lp.online ? 'online' : lp.seenAt ? `offline · ${ago(lp.seenAt)}` : 'offline'}
        </span>
      </div>
      {list.map((p) => (
        <a key={p.id} className="row laptop-row" href={off ? undefined : `${lp.url}/?project=${encodeURIComponent(p.id)}`} title={off ? 'Der Laptop ist aus' : 'Auf dem Laptop öffnen'}>
          <span className="handoff-icon">
            <Laptop size={14} />
          </span>
          <div className="row-text">
            <div className="row-name">{p.name}</div>
            <div className="row-line">
              {p.attention === 'waiting' ? 'wartet auf dich' : p.attention === 'working' ? 'arbeitet' : p.attention === 'done' ? 'fertig' : p.tabs ? `${p.tabs} offen` : ago(p.lastUsed || lp.seenAt)}
            </div>
          </div>
          <div className="row-mark">{p.attention && !off && <StatusMark attention={p.attention} />}</div>
        </a>
      ))}
      {lp.projects.length > 5 && (
        <button className="laptop-more" onClick={() => setAll(!all)}>
          {all ? 'Weniger' : `Alle ${lp.projects.length} zeigen`}
        </button>
      )}
    </div>
  );
}
