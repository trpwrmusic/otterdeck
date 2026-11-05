import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquarePlus, Send, X } from 'lucide-react';
import type { CompareMode, DiffLine, FileContent, FileDiff, ProjectView } from '../../shared/types';
import { api, useOnFileChange } from './api';
import { highlightLine, languageFor } from './highlight';

export interface ReviewComment {
  path: string;
  line: number;
  side: 'old' | 'new';
  code: string;
  text: string;
}

const lineNo = (l: DiffLine) => (l.t === '-' ? l.old! : l.new!);

/** Typed in front of the pasted comments, so Claude reads them as your request. */
export const COMMENTS_LEAD = 'Bitte setze meine Anmerkungen zu deinen Änderungen um:';

/** The comments for Claude, grouped by file. */
export function formatComments(comments: ReviewComment[]) {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  const parts: string[] = [];
  for (const [file, list] of byFile) {
    if (parts.length) parts.push('');
    parts.push(`${file}:`);
    for (const c of list.sort((a, b) => a.line - b.line)) {
      const code = c.code.trim().slice(0, 90);
      const where = c.side === 'old' ? `entfernte Zeile ${c.line}` : `Zeile ${c.line}`;
      parts.push(`- ${where}${code ? ` (\`${code}\`)` : ''}: ${c.text.trim()}`);
    }
  }
  return parts.join('\n');
}

interface Props {
  project: ProjectView;
  path: string;
  mode: CompareMode;
  comments: ReviewComment[];
  onAddComment: (c: ReviewComment) => void;
  onRemoveComment: (c: ReviewComment) => void;
  onSend: () => void;
  sending: boolean;
}

export function DiffView({ project, path, mode, comments, onAddComment, onRemoveComment, onSend, sending }: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftAt, setDraftAt] = useState<{ line: number; side: 'old' | 'new'; code: string } | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    api
      .diff(project.id, path, mode)
      .then((d) => {
        setDiff(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [project.id, path, mode]);
  useEffect(load, [load]);
  useOnFileChange(project.id, load);

  const lang = useMemo(() => languageFor(path), [path]);
  const mine = comments.filter((c) => c.path === path);
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(path);

  const commit = () => {
    if (draftAt && draft.trim()) onAddComment({ path, ...draftAt, text: draft });
    setDraftAt(null);
    setDraft('');
  };

  return (
    <div className="doc">
      <div className="doc-head">
        <span className="doc-path">{path}</span>
        {comments.length > 0 && (
          <button className="btn small primary" onClick={onSend} disabled={sending}>
            <Send size={14} /> {comments.length === 1 ? '1 Anmerkung' : `${comments.length} Anmerkungen`} an Claude
          </button>
        )}
      </div>
      <div className="doc-body">
        {error && <div className="doc-note">{error}</div>}
        {diff?.binary && (isImage ? <img className="doc-image" src={api.rawUrl(project.id, path)} alt="" /> : <div className="doc-note">Binärdatei</div>)}
        {diff?.tooLarge && <div className="doc-note">Die Änderungen sind zu groß für die Anzeige.</div>}
        {diff && !diff.binary && !diff.tooLarge && diff.hunks.length === 0 && <div className="doc-note">Keine Änderungen in dieser Datei.</div>}
        {diff && diff.hunks.length > 0 && (
          <table className="code diff">
            <tbody>
              {diff.hunks.map((h, hi) => (
                <Fragment key={hi}>
                  {(hi > 0 || h.oldStart > 1) && h.oldStart > 0 && (
                    <tr className="hunk">
                      <td colSpan={3}>
                        Zeile {h.newStart}
                        {h.header && <span className="hunk-fn">{h.header}</span>}
                      </td>
                    </tr>
                  )}
                  {h.lines.map((l, li) => {
                    const side = l.t === '-' ? 'old' : 'new';
                    const n = lineNo(l);
                    const here = mine.filter((c) => c.line === n && c.side === side);
                    const drafting = draftAt?.line === n && draftAt.side === side;
                    return (
                      <Fragment key={li}>
                        <tr className={l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}>
                          <td className="ln">{l.old ?? ''}</td>
                          <td className="ln">
                            {l.new ?? ''}
                            <button
                              className="comment-btn"
                              title="Anmerkung schreiben"
                              onClick={() => {
                                setDraftAt({ line: n, side, code: l.text });
                                setDraft('');
                              }}
                            >
                              <MessageSquarePlus size={13} />
                            </button>
                          </td>
                          <td className="src">
                            <span className="sign">{l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span>
                            <span dangerouslySetInnerHTML={{ __html: highlightLine(l.text, lang) || ' ' }} />
                          </td>
                        </tr>
                        {(here.length > 0 || drafting) && (
                          <tr className="comment-row">
                            <td colSpan={3}>
                              {here.map((c, ci) => (
                                <div className="comment" key={ci}>
                                  <span>{c.text}</span>
                                  <button className="icon-btn tiny" onClick={() => onRemoveComment(c)} title="Entfernen">
                                    <X size={13} />
                                  </button>
                                </div>
                              ))}
                              {drafting && (
                                <div className="comment-edit">
                                  <textarea
                                    autoFocus
                                    value={draft}
                                    placeholder="Was soll Claude hier ändern?"
                                    onChange={(e) => setDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        commit();
                                      } else if (e.key === 'Escape') setDraftAt(null);
                                    }}
                                  />
                                  <div className="comment-actions">
                                    <button className="btn small quiet" onClick={() => setDraftAt(null)}>
                                      Abbrechen
                                    </button>
                                    <button className="btn small primary" onClick={commit} disabled={!draft.trim()}>
                                      Anmerken
                                    </button>
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function FileView({ project, path }: { project: ProjectView; path: string }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .file(project.id, path)
      .then((f) => {
        setFile(f);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [project.id, path]);
  useEffect(load, [load]);
  useOnFileChange(project.id, load);

  const lang = useMemo(() => languageFor(path), [path]);
  const lines = useMemo(() => (file?.text ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'), [file]);
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(path);

  return (
    <div className="doc">
      <div className="doc-head">
        <span className="doc-path">{path}</span>
      </div>
      <div className="doc-body">
        {error && <div className="doc-note">{error}</div>}
        {file?.binary && (isImage ? <img className="doc-image" src={api.rawUrl(project.id, path)} alt="" /> : <div className="doc-note">Binärdatei</div>)}
        {file?.tooLarge && <div className="doc-note">Die Datei ist zu groß für die Anzeige.</div>}
        {file?.text !== null && file && (
          <table className="code">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="ln">{i + 1}</td>
                  <td className="src">
                    <span dangerouslySetInnerHTML={{ __html: highlightLine(l, lang) || ' ' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
