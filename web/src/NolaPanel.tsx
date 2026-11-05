import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronRight, ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import type { NolaTask, NolaTaskDetail, ProjectView } from '../../shared/types';
import { api } from './api';

const toast = (text: string) => window.dispatchEvent(new CustomEvent('otter:toast', { detail: text }));

function dueLabel(due: string | null, overdue: boolean) {
  if (!due) return null;
  const d = new Date(due + 'T12:00:00');
  const text = d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
  return <span className={`nola-due${overdue ? ' over' : ''}`}>{overdue ? `überfällig · ${text}` : text}</span>;
}

/** One NOLA task: tap to unfold description and subtasks; done, open, hand to Claude. */
function TaskRow({
  task,
  projectId,
  open,
  onToggle,
  onChanged,
  onClaude,
  isCard,
}: {
  task: NolaTask;
  projectId: string;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onClaude: (tabId: string) => void;
  isCard?: boolean;
}) {
  const [detail, setDetail] = useState<NolaTaskDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.nolaTask(task.id).then((d) => alive && setDetail(d)).catch((err) => toast(err.message));
    return () => {
      alive = false;
    };
  }, [open, task.id]);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
      onChanged();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`nola-task${open ? ' open' : ''}${task.done ? ' done' : ''}${isCard ? ' card' : ''}`}>
      <button className="nola-head" onClick={onToggle}>
        {!isCard && (
          <span
            className={`nola-check${task.done ? ' on' : ''}`}
            role="checkbox"
            aria-checked={task.done}
            title={task.done ? 'Wieder öffnen' : 'Erledigt'}
            onClick={(e) => {
              e.stopPropagation();
              run('check', () => api.nolaMove(task.id, task.done ? 'open' : 'done'));
            }}
          >
            {task.done && <Check size={11} strokeWidth={3} />}
          </span>
        )}
        <span className="nola-title">{isCard ? task.title : task.title.replace(/^[^:]{2,40}:\s*/, '')}</span>
        <span className="nola-meta">
          {task.subtasksTotal > 0 && (
            <span className="nola-sub">
              {task.subtasksDone}/{task.subtasksTotal}
            </span>
          )}
          {dueLabel(task.due, task.overdue)}
          <ChevronRight size={13} className={`nola-chev${open ? ' rot' : ''}`} />
        </span>
      </button>
      {open && (
        <div className="nola-body">
          {isCard && task.tags.length > 0 && (
            <div className="nola-tags">
              {task.tags.map((t) => (
                <span key={t} className="nola-tag">
                  {t}
                </span>
              ))}
              <span className="nola-col">{task.column}</span>
            </div>
          )}
          {!detail ? (
            <div className="usage-empty">Lädt …</div>
          ) : (
            <>
              {detail.description.trim() && <div className="nola-desc">{detail.description.trim()}</div>}
              {detail.subtasks.length > 0 && (
                <div className="nola-subs">
                  {detail.subtasks.map((s) => (
                    <label key={s.index} className={`nola-subtask${s.checked ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={s.checked}
                        disabled={!!busy}
                        onChange={(e) =>
                          run('sub', async () => setDetail(await api.nolaSubtask(task.id, s.index, e.target.checked)))
                        }
                      />
                      <span>{s.text}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="nola-actions">
            <button
              className="copy-btn primary"
              disabled={!!busy}
              onClick={() =>
                run('claude', async () => {
                  const { tabId } = await api.nolaClaude(task.id, projectId);
                  toast('Claude arbeitet die Aufgabe ab und hält NOLA auf Stand.');
                  onClaude(tabId);
                })
              }
            >
              <Sparkles size={12} /> {busy === 'claude' ? 'Startet …' : 'An Claude geben'}
            </button>
            {task.url && (
              <a className="copy-btn" href={task.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={12} /> In NOLA
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Side-panel tab: the project's NOLA card and its to-dos. */
export function NolaPanel({ project, onActivate, focusTask }: { project: ProjectView; onActivate: (tabId: string) => void; focusTask?: number | null }) {
  const [data, setData] = useState<{ card: NolaTask | null; todos: NolaTask[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(focusTask ?? null);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(
    (fresh = false) => {
      setBusy(true);
      api
        .nolaProject(project.id, fresh)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((err) => setError(err.message))
        .finally(() => setBusy(false));
    },
    [project.id],
  );
  useEffect(() => load(), [load]);
  useEffect(() => {
    if (focusTask) setOpen(focusTask);
  }, [focusTask]);

  const openTodos = data?.todos.filter((t) => !t.done) ?? [];
  const doneTodos = data?.todos.filter((t) => t.done) ?? [];
  const row = (t: NolaTask, isCard = false) => (
    <TaskRow
      key={t.id}
      task={t}
      projectId={project.id}
      isCard={isCard}
      open={open === t.id}
      onToggle={() => setOpen(open === t.id ? null : t.id)}
      onChanged={() => load(true)}
      onClaude={onActivate}
    />
  );

  return (
    <div className="nola-panel">
      <div className="nola-bar">
        <span className="nola-label">NOLA</span>
        <button className="icon-btn" title="Neu laden" onClick={() => load(true)}>
          <RefreshCw size={13} className={busy ? 'spin' : ''} />
        </button>
      </div>
      {error && <div className="remote-error">{error}</div>}
      {!data && !error && <div className="usage-empty">Lädt …</div>}
      {data && (
        <div className="nola-list">
          {data.card ? row(data.card, true) : <div className="usage-empty">Keine Projektkarte gefunden.</div>}
          {openTodos.length === 0 && <div className="usage-empty nola-none">Keine offenen Aufgaben.</div>}
          {openTodos.map((t) => row(t))}
          {doneTodos.length > 0 && (
            <>
              <button className="section-title toggle nola-done-toggle" onClick={() => setShowDone(!showDone)}>
                <ChevronRight size={12} className={`group-chev${showDone ? ' rot' : ''}`} /> Erledigt {doneTodos.length}
              </button>
              {showDone && doneTodos.map((t) => row(t))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
