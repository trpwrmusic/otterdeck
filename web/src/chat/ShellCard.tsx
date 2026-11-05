import { useState } from 'react';
import { SquareTerminal } from 'lucide-react';

const FOLD_AT = 14;

/** A "!" command and its output (Claude Code's bash mode): Claude sees both. */
export function ShellCard({ cmd, out, err }: { cmd: string; out: string | null; err: string }) {
  const text = [out ?? '', err].filter(Boolean).join(out && err ? '\n' : '');
  const lines = text ? text.split('\n').length : 0;
  const [open, setOpen] = useState(lines <= FOLD_AT);
  const running = out === null;
  return (
    <div className={`shell-card${running ? ' running' : ''}`}>
      <div className="shell-cmd">
        <SquareTerminal size={13} />
        <code>{cmd || 'Shell'}</code>
        {running && <span className="shell-run">läuft …</span>}
      </div>
      {!running && (
        <>
          {lines === 0 ? (
            <div className="shell-empty">keine Ausgabe</div>
          ) : (
            <pre className={`shell-out${open ? '' : ' folded'}`}>
              {out}
              {err && <span className="shell-err">{(out ? '\n' : '') + err}</span>}
            </pre>
          )}
          {lines > FOLD_AT && (
            <button className="shell-more" onClick={() => setOpen(!open)}>
              {open ? 'Weniger zeigen' : `Alle ${lines} Zeilen zeigen`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
