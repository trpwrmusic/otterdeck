import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppWindow, ArrowUpCircle, Check, Copy, FolderOpen, KanbanSquare, Laptop, Network, RefreshCw, Server, Smartphone, SquareTerminal, TriangleAlert } from 'lucide-react';
import type { AppState, Settings, SettingsKey, SettingsView } from '../../shared/types';
import { api, timeAgo } from './api';
import { Glide } from './Glide';

// ---------- building blocks ----------

export function Toggle({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="toggle-knob" />
    </button>
  );
}

function Row({ title, hint, children, fixed, wide }: { title: string; hint?: ReactNode; children?: ReactNode; fixed?: string; wide?: boolean }) {
  return (
    <div className={`set-row${wide ? ' wide' : ''}`}>
      <div className="set-text">
        <div className="set-title">{title}</div>
        {hint && <div className="set-hint">{hint}</div>}
        {fixed && <div className="set-fixed">Festgelegt durch die Umgebungsvariable {fixed}</div>}
      </div>
      {children && <div className="set-control">{children}</div>}
    </div>
  );
}

function Group({ title, icon, children, note }: { title: string; icon?: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group">
      <h2>
        {icon}
        {title}
      </h2>
      <div className="set-card">{children}</div>
      {note && <div className="set-note">{note}</div>}
    </section>
  );
}

/** A text or number setting, saved when you leave the field or press Enter. */
function Field({ k, view, save, placeholder, number, mono = true }: { k: SettingsKey; view: SettingsView; save: Save; placeholder?: string; number?: boolean; mono?: boolean }) {
  const value = view.values[k] as string | number;
  const shown = number && value === 0 ? '' : String(value ?? '');
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text.trim() === shown) return;
    save({ [k]: number ? Number(text.trim() || 0) : text.trim() } as Partial<Settings>);
  };
  return (
    <input
      className={`set-input${mono ? ' mono' : ''}${number ? ' short' : ''}`}
      value={text}
      inputMode={number ? 'numeric' : undefined}
      disabled={!!view.fixed[k]}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(e) => setText(number ? e.target.value.replace(/\D/g, '') : e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

export function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="set-copy">
      <code>{text}</code>
      <button className="btn quiet small" onClick={() => navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1400)))}>
        {done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Kopiert' : 'Kopieren'}
      </button>
    </div>
  );
}

/** How to install Claude Code on this system (the official installer). */
export const claudeInstall = (platform: string) =>
  platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';

type Save = (patch: Partial<Settings> & { recheck?: boolean }) => Promise<void>;

export function useSettings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(() => api.settings().then(setView, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const save: Save = async (patch) => {
    setError(null);
    try {
      setView(await api.saveSettings(patch));
      setSaved(true);
      setTimeout(() => setSaved(false), 1400);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { view, setView, load, save, error, setError, saved };
}

const LABELS: Partial<Record<SettingsKey, string>> = {
  role: 'Rolle',
  port: 'Port',
  servePort: 'Port im Tailnet',
  tailscaleCli: 'Tailscale-Programm',
  tailscaleSocket: 'Tailscale-Socket',
  tailnetProxy: 'Tailnet-Proxy',
  claudeBin: 'Claude-Programm',
  shellBin: 'Shell',
  agyBin: 'Antigravity',
  taskDir: 'Aufgabenordner',
  nolaEnabled: 'NOLA',
  nolaHelper: 'NOLA-Helfer',
  nolaProjectsBoard: 'NOLA-Projektboard',
  nolaTodoBoards: 'NOLA-Aufgabenboards',
};

// ---------- the page ----------

export function SettingsPage({ state }: { state: AppState }) {
  const { view, setView, load, save, error, setError, saved } = useSettings();
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  // Remote, server and update state live in the app state; reload when it changes.
  useEffect(() => {
    load();
  }, [load, state.update.pending, state.release?.latest, state.release?.ready]);

  if (!view) return <main className="pane settings">{error && <div className="set-error">{error}</div>}</main>;

  const v = view.values;
  const win = view.platform === 'win32';
  const server = v.role === 'server';
  const remote = state.remote;
  const u = view.update;
  const restartNames = view.restart.map((k) => LABELS[k] ?? k);

  const setRemote = async (on: boolean) => {
    setRemoteBusy(true);
    setError(null);
    try {
      await api.setRemote(on);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemoteBusy(false);
    }
  };
  const run = async (fn: () => Promise<SettingsView>) => {
    setError(null);
    try {
      setView(await fn());
    } catch (e) {
      setError((e as Error).message);
      load();
    }
  };

  return (
    <main className="pane settings">
      <div className="settings-inner">
        <h1>Einstellungen</h1>
        <p className="settings-lead">
          Otterdeck {u.version} auf {win ? 'Windows' : view.platform === 'darwin' ? 'macOS' : 'Linux'}
          {saved && <span className="set-saved"><Check size={13} /> Gespeichert</span>}
        </p>

        {(restartNames.length > 0 || state.update.pending) && (
          <div className="set-banner">
            <RefreshCw size={16} />
            <span>
              {state.update.pending
                ? 'Neustart vorgemerkt. Otterdeck startet neu, sobald kein Claude mehr arbeitet.'
                : `Gilt nach einem Neustart: ${restartNames.join(', ')}.`}
            </span>
            {!state.update.pending && (
              <button className="btn small primary" onClick={() => api.restart()}>
                Neu starten
              </button>
            )}
          </div>
        )}
        {error && <div className="set-error">{error}</div>}

        <Group title="Dieser Computer" icon={server ? <Server size={16} /> : <Laptop size={16} />}>
          <Row
            title="Rolle"
            fixed={view.fixed.role}
            hint={
              server
                ? 'Läuft ohne Fenster und wird über Tailscale geöffnet, vom Handy oder vom Laptop. Claude meldet sich mit einem langlebigen Token an.'
                : 'Dein Arbeitsrechner mit Otterdeck-Fenster. Aufgaben kannst du an einen Server abgeben.'
            }
          >
            <div className="segmented">
              <Glide selector="button.on" watch={[v.role]} />
              <button className={!server ? 'on' : ''} disabled={!!view.fixed.role} onClick={() => save({ role: 'desktop' })}>
                Arbeitsplatz
              </button>
              <button className={server ? 'on' : ''} disabled={!!view.fixed.role} onClick={() => save({ role: 'server' })}>
                Server
              </button>
            </div>
          </Row>
          {!server && (
            <Row title="Fenster beim Start öffnen" hint="Aus: Otterdeck startet nur im Hintergrund, zum Beispiel für den Zugriff vom Handy." fixed={view.fixed.openWindow}>
              <Toggle label="Fenster beim Start öffnen" on={v.openWindow} disabled={!!view.fixed.openWindow} onChange={(on) => save({ openWindow: on })} />
            </Row>
          )}
          {win && (
            <Row title="Mit Windows starten" hint="Startet Otterdeck nach der Anmeldung im Hintergrund, ohne Fenster.">
              <Toggle label="Mit Windows starten" on={v.autostart} onChange={(on) => save({ autostart: on })} />
            </Row>
          )}
          <Row title="Port" hint="Lokaler Port, auf dem Otterdeck läuft (nur auf diesem Computer erreichbar)." fixed={view.fixed.port}>
            <Field k="port" view={view} save={save} number placeholder="4747" />
          </Row>
        </Group>

        <Group
          title="Andere Geräte"
          icon={<Smartphone size={16} />}
          note="Nur in deinem Tailnet und nur mit deinem Tailscale-Konto. Otterdeck ist nie aus dem offenen Internet erreichbar."
        >
          <Row
            title="Zugang über Tailscale"
            hint={
              !remote.installed
                ? 'Tailscale ist nicht installiert. Installiere es auf diesem Computer und auf deinen Geräten, dann geht es hier weiter.'
                : !remote.running
                  ? 'Tailscale läuft gerade nicht. Starte es und melde dich an.'
                  : remote.enabled
                    ? `Offen unter ${remote.url ?? ''}${remote.owner ? `, nur für ${remote.owner}` : ''}`
                    : 'Öffne Otterdeck auf Handy, Tablet oder einem anderen Computer in deinem Tailnet.'
            }
          >
            {remote.installed && remote.running && (
              <Toggle label="Zugang über Tailscale" on={remote.enabled} disabled={remoteBusy || !!state.isRemote} onChange={setRemote} />
            )}
          </Row>
          {remote.enabled && remote.url && (
            <Row title="Adresse" wide>
              <CopyLine text={remote.url} />
            </Row>
          )}
          {remote.enabled && (
            <Row title="Gerade verbunden" hint={remote.devices.length ? remote.devices.map((d) => d.name).join(', ') : 'Kein Gerät'} />
          )}
          <Row title="Port im Tailnet" hint={`HTTPS-Port der Tailnet-Adresse. Leer heißt ${server ? '4747' : '443'}.`} fixed={view.fixed.servePort}>
            <Field k="servePort" view={view} save={save} number placeholder={server ? '4747' : '443'} />
          </Row>
        </Group>

        {!server ? (
          <Group title="Server" icon={<Server size={16} />}>
            <Row
              title="Verbundener Server"
              hint={
                state.server
                  ? state.server.reachable === false
                    ? 'Gerade nicht erreichbar.'
                    : state.server.tokenAt
                      ? `Claude-Anmeldung übertragen ${timeAgo(state.server.tokenAt)}.`
                      : 'Verbunden. Die Claude-Anmeldung fehlt noch: im Seitenbereich eines Projekts unter „Server“.'
                  : 'Ein Otterdeck in der Rolle Server, an das du Aufgaben abgibst. Eintragen im Seitenbereich eines Projekts unter „Server“.'
              }
            >
              {state.server && <code className="set-value">{state.server.url.replace('https://', '')}</code>}
            </Row>
          </Group>
        ) : (
          <Group title="Laptop" icon={<Laptop size={16} />}>
            <Row
              title="Verbundener Laptop"
              hint={
                state.laptop
                  ? state.laptop.online
                    ? 'Online. Seine Projekte stehen in der Seitenleiste unter „Laptop“.'
                    : `Offline, zuletzt gesehen ${timeAgo(state.laptop.seenAt)}.`
                  : 'Meldet sich von selbst, sobald du auf dem Laptop diesen Server einträgst.'
              }
            >
              {state.laptopUrl && <code className="set-value">{state.laptopUrl.replace('https://', '')}</code>}
            </Row>
            <Row title="Aufgabenordner" hint="Hier legt der Server abgegebene Aufgaben an." fixed={view.fixed.taskDir}>
              <Field k="taskDir" view={view} save={save} placeholder={view.found.taskDir} />
            </Row>
          </Group>
        )}

        <Group title="Claude Code" icon={<SquareTerminal size={16} />}>
          <Row
            title="Programm"
            fixed={view.fixed.claudeBin}
            hint={
              view.found.claudeVersion ? (
                `Version ${view.found.claudeVersion}${v.claudeBin ? '' : `, gefunden unter ${view.found.claude ?? ''}`}`
              ) : (
                <span className="set-warn">
                  <TriangleAlert size={13} /> Claude Code wurde nicht gefunden.
                </span>
              )
            }
            wide
          >
            <Field k="claudeBin" view={view} save={save} placeholder={view.found.claude ?? 'Automatisch'} />
          </Row>
          {!view.found.claudeVersion && (
            <Row title="Installieren" hint={`Im Terminal ausführen, danach hier „Erneut prüfen“.`} wide>
              <CopyLine text={claudeInstall(view.platform)} />
              <button className="btn small" onClick={() => save({ recheck: true }).then(() => setTimeout(load, 2500))}>
                Erneut prüfen
              </button>
            </Row>
          )}
          <Row title="Konten" hint={state.accounts.map((a) => (a.email ? `${a.label} (${a.email})` : a.label)).join(', ') || 'Noch keins angemeldet. Die Anmeldung erscheint im ersten Chat.'} />
          <Row
            title="Gemeinsames Gedächtnis"
            hint="Alle Projekte teilen sich die Erinnerungen deines Benutzerordners, statt dass jedes Projekt eigene sammelt."
          >
            <Toggle label="Gemeinsames Gedächtnis" on={v.sharedMemory} onChange={(on) => save({ sharedMemory: on })} />
          </Row>
          <Row title="Zusätzliche Startargumente" hint="Werden jedem neuen Claude-Tab mitgegeben, zum Beispiel --permission-mode default." fixed={view.fixed.claudeArgs} wide>
            <Field k="claudeArgs" view={view} save={save} placeholder="keine" />
          </Row>
        </Group>

        <Group title="Updates" icon={<ArrowUpCircle size={16} />}>
          {u.install === 'release' ? (
            <>
              <Row
                title={u.ready ? `Version ${u.ready} ist installiert` : u.latest && u.latest !== u.version && !u.error ? `Version ${u.latest} ist da` : 'Otterdeck ist aktuell'}
                hint={
                  u.busy === 'checking'
                    ? 'Suche nach Updates …'
                    : u.busy === 'downloading'
                      ? 'Lädt herunter …'
                      : u.busy === 'installing'
                        ? 'Wird installiert …'
                        : u.ready
                          ? 'Startet, sobald kein Claude mehr arbeitet.'
                          : u.error
                            ? u.error
                            : u.checkedAt
                              ? `Zuletzt geprüft ${timeAgo(u.checkedAt)}.`
                              : 'Noch nicht geprüft.'
                }
              >
                {!u.ready && u.latest && u.latest !== u.version && !u.error ? (
                  <button className="btn small primary" disabled={!!u.busy} onClick={() => run(api.installUpdate)}>
                    Jetzt aktualisieren
                  </button>
                ) : (
                  <button className="btn small" disabled={!!u.busy} onClick={() => run(api.checkUpdate)}>
                    Nach Updates suchen
                  </button>
                )}
              </Row>
              {u.notes && !u.ready && u.latest !== u.version && <pre className="set-notes">{u.notes}</pre>}
              <Row title="Automatisch nach Updates suchen" hint="Alle paar Stunden. Installiert wird erst, wenn du es bestätigst.">
                <Toggle label="Automatisch nach Updates suchen" on={v.updateCheck} onChange={(on) => save({ updateCheck: on })} />
              </Row>
            </>
          ) : (
            <Row
              title={u.install === 'git' ? 'Entwicklerfassung' : 'Eigene Fassung'}
              hint={
                u.install === 'git'
                  ? 'Läuft aus einem Git-Checkout. Aktualisieren mit git pull und npm run build, Otterdeck meldet dann von selbst „Neue Version bereit“.'
                  : 'Nicht über den Installer eingerichtet, deshalb ohne automatische Updates.'
              }
            />
          )}
        </Group>

        <button className="set-advanced-toggle" onClick={() => setAdvanced((a) => !a)}>
          {advanced ? 'Erweiterte Einstellungen ausblenden' : 'Erweiterte Einstellungen'}
        </button>

        {advanced && (
          <>
            <Group title="Programme" icon={<AppWindow size={16} />}>
              <Row title="Shell" hint="Für Shell-Tabs." fixed={view.fixed.shellBin} wide>
                <Field k="shellBin" view={view} save={save} placeholder={view.found.shell} />
              </Row>
              <Row title="Antigravity (agy)" hint={view.found.agy || v.agyBin ? "Googles Agent als zweiter Anbieter neben Claude." : 'Nicht installiert. Optional, als zweiter Anbieter neben Claude.'} fixed={view.fixed.agyBin} wide>
                <Field k="agyBin" view={view} save={save} placeholder={view.found.agy ?? 'Automatisch'} />
              </Row>
            </Group>

            <Group title="Tailscale" icon={<Network size={16} />}>
              <Row title="Programm" hint="Pfad zur Tailscale-Befehlszeile." fixed={view.fixed.tailscaleCli} wide>
                <Field k="tailscaleCli" view={view} save={save} placeholder={view.found.tailscale ?? 'Automatisch'} />
              </Row>
              <Row title="Socket" hint="Nur für ein Tailscale ohne Root-Rechte (Userspace)." fixed={view.fixed.tailscaleSocket} wide>
                <Field k="tailscaleSocket" view={view} save={save} placeholder="Standard" />
              </Row>
              <Row title="Proxy ins Tailnet" hint="Für Userspace-Tailscale: dessen HTTP-Proxy, zum Beispiel http://127.0.0.1:1055." fixed={view.fixed.tailnetProxy} wide>
                <Field k="tailnetProxy" view={view} save={save} placeholder="keiner" />
              </Row>
            </Group>

            {win && (
              <Group title="NOLA" icon={<KanbanSquare size={16} />}>
                <Row title="NOLA anbinden" hint="Projektkarten und Aufgaben aus NOLA im Seitenbereich. Braucht den Helfer nola.ps1." fixed={view.fixed.nolaEnabled}>
                  <Toggle label="NOLA anbinden" on={v.nolaEnabled} onChange={(on) => save({ nolaEnabled: on })} />
                </Row>
                {v.nolaEnabled && (
                  <>
                    <Row title="Helfer" fixed={view.fixed.nolaHelper} wide>
                      <Field k="nolaHelper" view={view} save={save} placeholder={view.found.nolaHelper} />
                    </Row>
                    <Row title="Projektboard" hint="ID des Boards mit einer Karte pro Projekt." fixed={view.fixed.nolaProjectsBoard}>
                      <Field k="nolaProjectsBoard" view={view} save={save} number placeholder="5" />
                    </Row>
                    <Row title="Aufgabenboards" hint="IDs, durch Komma getrennt." fixed={view.fixed.nolaTodoBoards}>
                      <Field k="nolaTodoBoards" view={view} save={save} placeholder="6,2" mono={false} />
                    </Row>
                  </>
                )}
              </Group>
            )}

            <Group title="Daten" icon={<FolderOpen size={16} />}>
              <Row title="Datenordner" hint="Projekte, Tabs, Einstellungen und Protokoll." wide>
                <code className="set-value">{view.dataDir}</code>
              </Row>
            </Group>
          </>
        )}
      </div>
    </main>
  );
}
