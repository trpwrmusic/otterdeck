import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, File, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import type { ChangedFile, Changes, CompareMode, DirEntry, ProjectView } from '../../shared/types';
import { api, useOnFileChange, usePersisted } from './api';

const STATUS_LABEL: Partial<Record<ChangedFile['status'], string>> = {
  added: 'neu',
  untracked: 'neu',
  deleted: 'gelöscht',
  renamed: 'umbenannt',
  conflict: 'Konflikt',
};

interface Props {
  project: ProjectView;
  mode: CompareMode;
  onMode: (m: CompareMode) => void;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  activePath: string | null;
}

export function ChangesPanel(props: Props) {
  const [tab, setTab] = usePersisted<'changes' | 'files'>('otter.panelTab', 'changes');
  return (
    <aside className="side-panel">
      <div className="segmented panel-switch">
        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
          Änderungen
        </button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
          Dateien
        </button>
      </div>
      {tab === 'changes' ? <ChangeList {...props} /> : <FileTree {...props} />}
    </aside>
  );
}

function ChangeList({ project, mode, onMode, onOpenDiff, activePath }: Props) {
  const [data, setData] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    api
      .changes(project.id, mode)
      .then((c) => {
        setData(c);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [project.id, mode]);

  useEffect(load, [load]);
  useOnFileChange(project.id, load);
  // The watcher stops after a while without requests; asking now and then keeps it alive.
  useEffect(() => {
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="panel-empty">{error}</div>;
  if (!data) return <div className="panel-empty" />;
  if (!data.isRepo) return <div className="panel-empty">Dieser Ordner ist kein Git-Repository.</div>;

  // Group by folder, keeping git's order.
  const groups: { dir: string; files: ChangedFile[] }[] = [];
  for (const f of data.files) {
    const i = f.path.lastIndexOf('/');
    const dir = i < 0 ? '' : f.path.slice(0, i);
    if (groups.at(-1)?.dir !== dir) groups.push({ dir, files: [] });
    groups.at(-1)!.files.push(f);
  }

  return (
    <div className="changes">
      <div className="branch-card">
        <div className="branch-line">
          <span className="branch-name">{data.branch ?? 'losgelöster HEAD'}</span>
          {data.upstream && (data.ahead > 0 || data.behind > 0) && (
            <span className="ab" title={`gegenüber ${data.upstream}`}>
              {data.ahead > 0 && (
                <span>
                  <ArrowUp size={12} strokeWidth={2.6} />
                  {data.ahead}
                </span>
              )}
              {data.behind > 0 && (
                <span>
                  <ArrowDown size={12} strokeWidth={2.6} />
                  {data.behind}
                </span>
              )}
            </span>
          )}
          <button className={`icon-btn tiny${busy ? ' spin' : ''}`} onClick={load} title="Neu laden">
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="compare">
          <button className={mode === 'head' ? 'on' : ''} onClick={() => onMode('head')}>
            Seit letztem Commit
          </button>
          {data.base && (
            <button className={mode === 'base' ? 'on' : ''} onClick={() => onMode('base')} title={`Alles, was dieser Branch gegenüber ${data.base} ändert`}>
              Gegenüber {data.base.replace(/^origin\//, '')}
            </button>
          )}
        </div>
      </div>

      {data.files.length === 0 ? (
        <div className="panel-empty">{mode === 'head' ? 'Keine Änderungen seit dem letzten Commit.' : 'Keine Änderungen gegenüber der Basis.'}</div>
      ) : (
        <>
          <div className="changes-sum">
            {data.files.length === 1 ? '1 Datei' : `${data.files.length} Dateien`}
            <span className="plus">+{data.added}</span>
            <span className="minus">−{data.removed}</span>
          </div>
          <div className="change-list">
            {groups.map((g) => (
              <div key={g.dir} className="change-group">
                {g.dir && <div className="change-dir">{g.dir}</div>}
                {g.files.map((f) => (
                  <button
                    key={f.path}
                    className={`change${activePath === f.path ? ' active' : ''}${f.status === 'deleted' ? ' deleted' : ''}`}
                    onClick={() => onOpenDiff(f.path)}
                    title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                  >
                    <span className="change-name">{f.path.split('/').pop()}</span>
                    {STATUS_LABEL[f.status] && <span className={`tag ${f.status}`}>{STATUS_LABEL[f.status]}</span>}
                    <span className="change-nums">
                      {f.binary ? (
                        <span className="quiet">binär</span>
                      ) : (
                        <>
                          {f.added > 0 && <span className="plus">+{f.added}</span>}
                          {f.removed > 0 && <span className="minus">−{f.removed}</span>}
                        </>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FileTree({ project, onOpenFile, activePath }: Props) {
  // One open/closed map for the whole tree (each folder writing its own copy would undo the others).
  const [open, setOpen] = usePersisted<Record<string, boolean>>(`otter.tree.${project.id}`, {});
  const toggle = (p: string) => setOpen((o) => ({ ...o, [p]: !o[p] }));
  return (
    <div className="tree">
      <TreeDir project={project} path="" depth={0} onOpenFile={onOpenFile} activePath={activePath} open={open} toggle={toggle} />
    </div>
  );
}

function TreeDir({
  project,
  path,
  depth,
  onOpenFile,
  activePath,
  open,
  toggle,
}: {
  project: ProjectView;
  path: string;
  depth: number;
  onOpenFile: (p: string) => void;
  activePath: string | null;
  open: Record<string, boolean>;
  toggle: (p: string) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const load = useCallback(() => {
    api.files(project.id, path).then(setEntries).catch(() => setEntries([]));
  }, [project.id, path]);
  useEffect(load, [load]);
  useOnFileChange(project.id, load);

  if (!entries) return null;
  return (
    <>
      {entries.map((e) => {
        const p = path ? `${path}/${e.name}` : e.name;
        const isOpen = !!open[p];
        return (
          <div key={p}>
            <button
              className={`tree-row${e.quiet ? ' quiet' : ''}${activePath === p ? ' active' : ''}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => (e.dir ? toggle(p) : onOpenFile(p))}
            >
              {e.dir ? (
                <>
                  <ChevronRight size={13} className={`tree-chev${isOpen ? ' rot' : ''}`} />
                  {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                </>
              ) : (
                <>
                  <span className="tree-chev" />
                  <File size={14} />
                </>
              )}
              <span className="tree-name">{e.name}</span>
            </button>
            {e.dir && isOpen && <TreeDir project={project} path={p} depth={depth + 1} onOpenFile={onOpenFile} activePath={activePath} open={open} toggle={toggle} />}
          </div>
        );
      })}
    </>
  );
}
