import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ClipboardList, Hand, Pencil, Sparkles } from 'lucide-react';
import type { PermissionMode, TabView } from '../../../shared/types';
import { api } from '../api';

export interface Attachment {
  key: string;
  name: string;
  size: number;
  /** Object URL for images, shown as a thumbnail. */
  preview: string | null;
  /** Where the server stored it (null while uploading or after an error). */
  path: string | null;
  uploading: boolean;
  error: string | null;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export const MODES: { id: PermissionMode; label: string; hint: string; icon: typeof Hand }[] = [
  { id: 'default', label: 'Fragt nach', hint: 'Vor Änderungen und Befehlen um Erlaubnis bitten', icon: Hand },
  { id: 'acceptEdits', label: 'Änderungen automatisch', hint: 'Dateien ändern ohne zu fragen, Befehle mit Nachfrage', icon: Pencil },
  { id: 'plan', label: 'Plan', hint: 'Nur planen und lesen, nichts ändern', icon: ClipboardList },
  { id: 'auto', label: 'Auto', hint: 'Claude entscheidet selbst, wann es fragt', icon: Sparkles },
];

export function modeOf(tab: TabView) {
  return MODES.find((m) => m.id === tab.mode) ?? (tab.mode === 'bypass' ? { id: 'bypass' as const, label: 'Ohne Rückfragen', hint: '', icon: Sparkles } : null);
}

/** The modes as a list (used in the menu and in the phone sheet). */
export function ModeList({ tab, onDone }: { tab: TabView; onDone?: () => void }) {
  const [busy, setBusy] = useState<PermissionMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (id: PermissionMode) => {
    setBusy(id);
    setError(null);
    try {
      await api.setMode(tab.id, id);
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {MODES.filter((m) => tab.kind !== 'agy' || m.id !== 'bypass').map((m) => (
        <button key={m.id} className={`mode-item${m.id === tab.mode ? ' sel' : ''}`} onClick={() => choose(m.id)} disabled={busy !== null}>
          <m.icon size={15} />
          <span className="mode-text">
            <span className="mode-label">{m.label}</span>
            <span className="mode-hint">{m.hint}</span>
          </span>
          {busy === m.id ? <span className="mark working" style={{ width: 12, height: 12 }} /> : m.id === tab.mode ? <Check size={14} /> : null}
        </button>
      ))}
      {error && <div className="mode-error">{error}</div>}
    </>
  );
}

/** The permission mode of this tab, switchable like Shift+Tab in the terminal. */
export function ModeMenu({ tab }: { tab: TabView }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = modeOf(tab);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const Icon = current?.icon ?? Hand;
  return (
    <div className="mode" ref={box}>
      <button className={`mode-btn${tab.mode && tab.mode !== 'default' ? ' on' : ''}`} onClick={() => setOpen(!open)} title="Modus (wie Umschalt+Tab im Terminal)">
        <Icon size={14} />
        <span className="mode-btn-label">{current?.label ?? 'Modus'}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="mode-menu" role="menu">
          <ModeList tab={tab} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
