import { useEffect, useState } from 'react';
import type { AccountView, UsageView } from '../../shared/types';

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function until(ms: number, now: number) {
  const min = Math.max(1, Math.round((ms - now) / 60_000));
  if (min < 60) return `in ${min} Min.`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} Std.${min % 60 ? ` ${min % 60} Min.` : ''}`;
  return new Date(ms).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}

function ago(ms: number, now: number) {
  const min = Math.round((now - ms) / 60_000);
  if (min < 2) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  return h < 24 ? `vor ${h} Std.` : `vor ${Math.round(h / 24)} T.`;
}

/** Plan limits of the account the current Claude tab runs with (bottom of the side panel). */
export function UsageCard({ account, accounts, usage }: { account: string | null; accounts: AccountView[]; usage: UsageView[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const acc = account ? accounts.find((a) => norm(a.dir) === norm(account)) : accounts.find((a) => a.isDefault);
  const dir = account ?? acc?.dir ?? null;
  const u = dir ? usage.find((x) => norm(x.account) === norm(dir)) : undefined;
  const label = acc?.label ?? 'Standard';

  return (
    <section className="usage-card" aria-label="Nutzungslimits">
      <div className="usage-head">
        <span className="usage-title">Limits</span>
        <span className="usage-account" title={acc?.email ?? dir ?? ''}>
          {label}
        </span>
      </div>
      {!u ? (
        <div className="usage-empty">Erscheint, sobald Claude in diesem Konto geantwortet hat.</div>
      ) : (
        <>
          {u.windows.map((w) => {
            const over = w.resetsAt != null && w.resetsAt <= now;
            const pct = over ? 0 : Math.round(w.percent);
            const tone = pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : '';
            return (
              <div key={w.key} className={`usage-row ${tone}`}>
                <div className="usage-line">
                  <span>{w.label}</span>
                  <span className="usage-pct">{pct} %</span>
                </div>
                <div className="usage-bar">
                  <span style={{ width: `${pct}%` }} />
                </div>
                {w.resetsAt != null && <div className="usage-reset">{over ? 'Inzwischen zurückgesetzt' : `Zurückgesetzt ${until(w.resetsAt, now)}`}</div>}
              </div>
            );
          })}
          <div className="usage-at">Stand {ago(u.at, now)}</div>
        </>
      )}
    </section>
  );
}
