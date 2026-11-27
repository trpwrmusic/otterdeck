import { useState } from 'react';
import { ArrowRight, Check, Laptop, Server, Smartphone, TriangleAlert } from 'lucide-react';
import type { AppState } from '../../shared/types';
import { api } from './api';
import { CopyLine, Toggle, claudeInstall, useSettings } from './SettingsPage';

/**
 * First start on a new computer: what this Otterdeck is for, whether Claude Code is there, and
 * access from other devices. Everything here can be changed later in the settings.
 */
export function SetupPage({ state }: { state: AppState }) {
  const { view, load, save, error, setError } = useSettings();
  const [step, setStep] = useState(0);
  const [checking, setChecking] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);

  if (!view) return <main className="pane settings setup" />;
  const v = view.values;
  const server = v.role === 'server';
  const remote = state.remote;
  const finish = () => save({ setupDone: true });
  const restartNeeded = view.restart.includes('role');

  const recheck = async () => {
    setChecking(true);
    await save({ recheck: true });
    setTimeout(() => load().finally(() => setChecking(false)), 2500);
  };
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

  const steps = ['Rolle', 'Claude Code', 'Andere Geräte'];

  return (
    <main className="pane settings setup">
      <div className="setup-inner">
        <div className="setup-steps">
          {steps.map((s, i) => (
            <button key={s} className={`setup-step${i === step ? ' on' : ''}${i < step ? ' done' : ''}`} onClick={() => setStep(i)}>
              {i < step ? <Check size={12} strokeWidth={3} /> : <span>{i + 1}</span>} {s}
            </button>
          ))}
        </div>

        {step === 0 && (
          <>
            <h1>Willkommen bei Otterdeck</h1>
            <p className="settings-lead">Wofür ist dieser Computer da? Das lässt sich später in den Einstellungen ändern.</p>
            <div className="setup-choices">
              <button className={`setup-choice${!server ? ' on' : ''}`} disabled={!!view.fixed.role} onClick={() => save({ role: 'desktop' })}>
                <Laptop size={26} />
                <b>Arbeitsplatz</b>
                <span>Du arbeitest direkt an diesem Computer, mit Otterdeck-Fenster. Optional auch vom Handy aus.</span>
              </button>
              <button className={`setup-choice${server ? ' on' : ''}`} disabled={!!view.fixed.role} onClick={() => save({ role: 'server' })}>
                <Server size={26} />
                <b>Server</b>
                <span>Läuft ohne Bildschirm durch. Du öffnest ihn vom Handy oder Laptop über Tailscale und gibst Aufgaben ab.</span>
              </button>
            </div>
            {restartNeeded && <div className="set-note">Die Rolle gilt nach dem Neustart am Ende der Einrichtung.</div>}
          </>
        )}

        {step === 1 && (
          <>
            <h1>Claude Code</h1>
            {view.found.claudeVersion ? (
              <div className="setup-ok">
                <Check size={18} /> Claude Code {view.found.claudeVersion} ist installiert.
              </div>
            ) : (
              <>
                <p className="settings-lead">Otterdeck startet Claude Code in Tabs. Es ist auf diesem Computer noch nicht installiert. Führ dazu in einem Terminal aus:</p>
                <CopyLine text={claudeInstall(view.platform)} />
                <div className="setup-row">
                  <span className="set-warn">
                    <TriangleAlert size={13} /> Noch nicht gefunden
                  </span>
                  <button className="btn small" disabled={checking} onClick={recheck}>
                    {checking ? 'Prüfe …' : 'Erneut prüfen'}
                  </button>
                </div>
              </>
            )}
            <p className="setup-text">
              {server
                ? 'Anmelden: Auf deinem Laptop trägst du diesen Server ein, dann überträgt Otterdeck eine langlebige Claude-Anmeldung hierher.'
                : 'Anmelden musst du dich hier nicht: Fragt Claude im ersten Chat nach der Anmeldung, zeigt Otterdeck dir den Link und ein Feld für den Code.'}
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Andere Geräte</h1>
            <p className="settings-lead">
              {server
                ? 'Ein Server wird über Tailscale geöffnet. Nur Geräte in deinem Tailnet mit deinem Konto kommen hinein.'
                : 'Mit Tailscale öffnest du Otterdeck auch auf dem Handy oder einem anderen Computer. Nur in deinem Tailnet, nie aus dem offenen Internet.'}
            </p>
            <div className="set-card">
              <div className="set-row">
                <div className="set-text">
                  <div className="set-title">
                    <Smartphone size={15} /> Zugang über Tailscale
                  </div>
                  <div className="set-hint">
                    {!remote.installed
                      ? 'Tailscale ist nicht installiert. Lade es unter tailscale.com/download, melde dich an und komm hierher zurück.'
                      : !remote.running
                        ? 'Tailscale läuft gerade nicht. Starte es und melde dich an.'
                        : remote.enabled
                          ? `Offen unter ${remote.url ?? ''}`
                          : 'Einschalten, um Otterdeck in deinem Tailnet zu öffnen.'}
                  </div>
                </div>
                {remote.installed && remote.running && (
                  <div className="set-control">
                    <Toggle label="Zugang über Tailscale" on={remote.enabled} disabled={remoteBusy || !!state.isRemote} onChange={setRemote} />
                  </div>
                )}
              </div>
            </div>
            {!remote.installed && <p className="setup-text">Das kannst du auch überspringen und später in den Einstellungen einschalten.</p>}
          </>
        )}

        {error && <div className="set-error">{error}</div>}

        <div className="setup-nav">
          {step > 0 && (
            <button className="btn quiet" onClick={() => setStep(step - 1)}>
              Zurück
            </button>
          )}
          <span className="setup-gap" />
          {step < steps.length - 1 ? (
            <button className="btn primary" onClick={() => setStep(step + 1)}>
              Weiter <ArrowRight size={15} />
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={async () => {
                await finish();
                if (restartNeeded) api.restart(undefined, true);
              }}
            >
              {restartNeeded ? 'Fertig und neu starten' : 'Fertig'} <Check size={15} />
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
