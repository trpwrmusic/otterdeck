import { useMemo, useState } from 'react';
import { Smartphone } from 'lucide-react';
import qrcode from 'qrcode-generator';
import type { RemoteView } from '../../shared/types';
import { api, usePersisted } from './api';

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
  }, [text]);
  return <div className="remote-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Phone access over Tailscale (bottom of the side panel, under the limits). */
export function RemoteCard({ remote, isRemote }: { remote: RemoteView; isRemote: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [unfolded, setUnfolded] = usePersisted('otter.card.remote', false);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.setRemote(on);
      if (on) setShowQr(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (!remote.installed) body = <div className="usage-empty">Installiere Tailscale auf PC und Handy, dann geht es hier weiter.</div>;
  else if (!remote.running) body = <div className="usage-empty">Tailscale läuft gerade nicht. Starte es und melde dich an.</div>;
  else if (!remote.enabled)
    body = (
      <>
        <div className="usage-empty">Öffne Otterdeck auf dem Handy, nur in deinem Tailnet und nur mit deinem Tailscale-Konto.</div>
        {!isRemote && (
          <button className="copy-btn primary remote-on" disabled={busy} onClick={() => toggle(true)}>
            {busy ? 'Schalte ein …' : 'Handy-Zugang einschalten'}
          </button>
        )}
      </>
    );
  else
    body = (
      <>
        <div className="remote-devices">
          {remote.devices.length === 0 ? (
            <span className="usage-empty">Gerade kein Gerät verbunden</span>
          ) : (
            remote.devices.map((d) => (
              <span key={d.name} className="remote-device">
                <span className="remote-dot" />
                {d.name}
              </span>
            ))
          )}
        </div>
        {remote.url && !isRemote && (
          <>
            {showQr && <Qr text={remote.url} />}
            <div className="remote-actions">
              <button className="copy-btn" onClick={() => setShowQr((v) => !v)}>
                {showQr ? 'QR ausblenden' : 'QR-Code'}
              </button>
              <button className="copy-btn" data-copy={encodeURIComponent(remote.url)} onClick={(e) => navigator.clipboard.writeText(remote.url!).then(() => {
                const b = e.currentTarget; const l = b.textContent; b.textContent = 'Kopiert ✓'; setTimeout(() => (b.textContent = l), 1400);
              })}>
                Adresse kopieren
              </button>
              <button className="copy-btn" disabled={busy} onClick={() => toggle(false)}>
                Ausschalten
              </button>
            </div>
          </>
        )}
      </>
    );

  // Folded to one line unless there's something to read (an error) or you opened it.
  const folded = !unfolded && !error && !remote.error;
  return (
    <section className={`usage-card remote-card fold${folded ? ' folded' : ''}`} aria-label="Handy-Zugang">
      <div className="usage-head" role="button" tabIndex={0} onClick={() => setUnfolded(!unfolded)} title={folded ? 'Aufklappen' : 'Einklappen'}>
        <span className="usage-title">
          <Smartphone size={14} /> Handy
        </span>
        <span className={`usage-account${remote.enabled ? ' on' : ''}`}>{remote.enabled ? (remote.url ?? '').replace('https://', '') : 'aus'}</span>
      </div>
      {!folded && body}
      {(error || remote.error) && <div className="remote-error">{error ?? remote.error}</div>}
    </section>
  );
}
