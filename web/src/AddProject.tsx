import { useEffect, useRef, useState } from 'react';
import { Folder, FolderPlus, GitBranch } from 'lucide-react';
import type { Suggestion } from '../../shared/types';
import { api, timeAgo, usePersisted } from './api';
import { Glide } from './Glide';

/** Folder field with autocomplete of subfolders (↑/↓, Tab). */
function FolderField({
  value,
  onChange,
  onSubmit,
  placeholder,
  autoFocus,
  action,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder: string;
  autoFocus?: boolean;
  action?: React.ReactNode;
}) {
  const [dirs, setDirs] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => api.dirs(value).then((d) => live && (setDirs(d), setHi(-1))).catch(() => {}), 80);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value]);
  const choose = (d: string) => {
    onChange(d + '\\');
    input.current?.focus();
  };
  return (
    <>
      <div className="field">
        <Folder size={18} className="field-icon" />
        <input
          ref={input}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHi((h) => Math.min(dirs.length - 1, h + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHi((h) => Math.max(-1, h - 1));
            } else if (e.key === 'Tab' && dirs.length) {
              e.preventDefault();
              choose(dirs[Math.max(0, hi)]);
            } else if (e.key === 'Enter' && hi >= 0 && dirs[hi]) {
              e.preventDefault();
              choose(dirs[hi]);
            } else if (e.key === 'Enter' && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
        />
        {action}
      </div>
      {dirs.length > 0 && (
        <div className="dir-list">
          {dirs.map((d, i) => (
            <button type="button" key={d} className={`dir${i === hi ? ' hi' : ''}`} onClick={() => choose(d)}>
              <Folder size={15} /> {d.split('\\').pop()}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function AddProject({ onAdded }: { onAdded: (id: string) => void }) {
  const [mode, setMode] = usePersisted<'new' | 'existing'>('otter.addMode', 'new');
  const [path, setPath] = useState('C:\\dev\\');
  const [parent, setParent] = usePersisted('otter.newParent', 'C:\\dev\\web\\');
  const [name, setName] = useState('');
  const [git, setGit] = usePersisted('otter.newGit', true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);

  useEffect(() => {
    api.suggestions().then(setSuggestions).catch(() => setSuggestions([]));
  }, []);
  useEffect(() => setError(null), [mode]);

  const run = async (fn: () => Promise<{ id: string }>) => {
    setError(null);
    setBusy(true);
    try {
      const { id } = await fn();
      onAdded(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = (p: string) => run(() => api.addProject(p));
  const create = () => {
    if (!name.trim()) return setError('Wie soll das Projekt heißen?');
    run(() => api.createProject(parent.replace(/\\+$/, ''), name.trim(), git));
  };
  const target = `${parent.replace(/\\+$/, '')}\\${name.trim() || '…'}`;

  return (
    <main className="pane add">
      <div className="add-inner">
        <h1>{mode === 'new' ? 'Neues Projekt' : 'Projekt hinzufügen'}</h1>

        <div className="segmented add-mode">
          <Glide selector="button.on" watch={[mode]} />
          <button className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
            Neues Projekt
          </button>
          <button className={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>
            Vorhandener Ordner
          </button>
        </div>

        {mode === 'new' ? (
          <form
            className="add-form new-project"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <label className="add-label">Name</label>
            <div className="field">
              <FolderPlus size={18} className="field-icon" />
              <input autoFocus value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} placeholder="mein-projekt" />
            </div>
            <label className="add-label">Ort</label>
            <FolderField value={parent} onChange={setParent} onSubmit={create} placeholder="C:\dev\web" />
            <label className="add-check">
              <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} />
              <GitBranch size={15} /> Git einrichten
            </label>
            <div className="add-target">
              Wird angelegt: <code>{target}</code>
            </div>
            {error && <div className="add-error">{error}</div>}
            <button className="btn primary big add-create" type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Lege an …' : 'Projekt anlegen'}
            </button>
          </form>
        ) : (
          <>
            <form
              className="add-form"
              onSubmit={(e) => {
                e.preventDefault();
                add(path.replace(/\\+$/, '') || path);
              }}
            >
              <FolderField
                value={path}
                onChange={setPath}
                autoFocus
                placeholder="C:\dev\mein-projekt"
                action={
                  <button className="btn primary" type="submit" disabled={busy}>
                    Hinzufügen
                  </button>
                }
              />
              {error && <div className="add-error">{error}</div>}
            </form>

            {suggestions && suggestions.length > 0 && (
              <section className="add-suggest">
                <h3>Hier hast du Claude Code schon benutzt</h3>
                <div className="suggest-grid">
                  {suggestions.map((s) => (
                    <button key={s.path} className="suggest" onClick={() => add(s.path)}>
                      <FolderPlus size={20} className="suggest-icon" />
                      <span className="suggest-name">{s.name}</span>
                      <span className="suggest-path">{s.path}</span>
                      <span className="suggest-time">{timeAgo(s.lastUsed)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
