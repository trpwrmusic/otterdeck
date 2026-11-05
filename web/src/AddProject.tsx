import { useEffect, useRef, useState } from 'react';
import { Folder, FolderPlus } from 'lucide-react';
import type { Suggestion } from '../../shared/types';
import { api, timeAgo } from './api';

export function AddProject({ onAdded }: { onAdded: (id: string) => void }) {
  const [path, setPath] = useState('C:\\dev\\');
  const [dirs, setDirs] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.suggestions().then(setSuggestions).catch(() => setSuggestions([]));
    input.current?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => api.dirs(path).then((d) => live && (setDirs(d), setHi(-1))).catch(() => {}), 80);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [path]);

  const add = async (p: string) => {
    setError(null);
    try {
      const { id } = await api.addProject(p);
      onAdded(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const choose = (d: string) => {
    setPath(d + '\\');
    input.current?.focus();
  };

  return (
    <main className="pane add">
      <div className="add-inner">
        <h1>Projekt hinzufügen</h1>

        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (hi >= 0 && dirs[hi]) choose(dirs[hi]);
            else add(path.replace(/\\+$/, '') || path);
          }}
        >
          <div className="field">
            <Folder size={18} className="field-icon" />
            <input
              ref={input}
              value={path}
              spellCheck={false}
              onChange={(e) => setPath(e.target.value)}
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
                }
              }}
              placeholder="C:\dev\mein-projekt"
            />
            <button className="btn primary" type="submit">
              Hinzufügen
            </button>
          </div>
          {error && <div className="add-error">{error}</div>}
          {dirs.length > 0 && (
            <div className="dir-list">
              {dirs.map((d, i) => (
                <button type="button" key={d} className={`dir${i === hi ? ' hi' : ''}`} onClick={() => choose(d)}>
                  <Folder size={15} /> {d.split('\\').pop()}
                </button>
              ))}
            </div>
          )}
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
      </div>
    </main>
  );
}
