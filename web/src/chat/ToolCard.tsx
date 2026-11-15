import { useState } from 'react';
import {
  Bot,
  ChevronRight,
  CircleCheck,
  Circle,
  CircleDot,
  FilePen,
  FilePlus2,
  FileSearch,
  Globe,
  ListTodo,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import type { ChatItem } from '../../../shared/types';
import { highlightLine, languageFor } from '../highlight';
import { lineDiff, withContext } from './lineDiff';
import { renderMarkdown } from './markdown';

type Tool = Extract<ChatItem, { k: 'tool' }>;

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export const isEdit = (t: Tool) => EDITS.has(t.name);

function iconFor(name: string) {
  if (name === 'Bash' || name === 'PowerShell') return SquareTerminal;
  if (name === 'Read' || name === 'NotebookRead') return FileSearch;
  if (name === 'Grep' || name === 'Glob') return Search;
  if (name === 'WebFetch' || name === 'WebSearch') return Globe;
  if (name === 'Task' || name === 'Agent') return Bot;
  if (name === 'TodoWrite') return ListTodo;
  if (name === 'Write') return FilePlus2;
  if (EDITS.has(name)) return FilePen;
  return Wrench;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const shortPath = (p: string) => p.replace(/\\/g, '/').split('/').slice(-3).join('/');

function Diff({ before, after, path }: { before: string; after: string; path: string }) {
  const lang = languageFor(path);
  const rows = withContext(lineDiff(before, after));
  return (
    <div className="mini-diff">
      {rows.map((r, i) =>
        r.t === 'gap' ? (
          <div key={i} className="md-gap">
            {r.count} unveränderte Zeilen
          </div>
        ) : (
          <div key={i} className={`md-line ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : ''}`}>
            <span className="sign">{r.t === ' ' ? '' : r.t === '-' ? '−' : '+'}</span>
            <span dangerouslySetInnerHTML={{ __html: highlightLine(r.text, lang) || ' ' }} />
          </div>
        ),
      )}
    </div>
  );
}

/** A file change, shown as a diff right in the conversation. */
export function EditCard({ tool }: { tool: Tool }) {
  const path = str(tool.input.file_path) || str(tool.input.notebook_path);
  const Icon = iconFor(tool.name);
  const [open, setOpen] = useState(true);
  let body: React.ReactNode = null;
  if (tool.name === 'Write') {
    const content = str(tool.input.content).replace(/\r?\n$/, '');
    const lines = content.split('\n');
    body = <Diff before="" after={lines.slice(0, 60).join('\n') + (lines.length > 60 ? `\n… ${lines.length - 60} weitere Zeilen` : '')} path={path} />;
  } else if (tool.name === 'MultiEdit' && Array.isArray(tool.input.edits)) {
    body = (tool.input.edits as any[]).map((e, i) => <Diff key={i} before={str(e.old_string)} after={str(e.new_string)} path={path} />);
  } else body = <Diff before={str(tool.input.old_string)} after={str(tool.input.new_string)} path={path} />;
  return (
    <div className={`edit-card${tool.result?.error ? ' error' : ''}`}>
      <button className="edit-head" onClick={() => setOpen(!open)}>
        <Icon size={15} />
        <span className="edit-path">{shortPath(path)}</span>
        {tool.result?.error && <span className="tag deleted">fehlgeschlagen</span>}
        <ChevronRight size={14} className={`chev${open ? ' rot' : ''}`} />
      </button>
      {open && body}
      {open && tool.result?.error && <pre className="tool-out">{tool.result.text}</pre>}
    </div>
  );
}

export function TodoCard({ tool }: { tool: Tool }) {
  const todos = Array.isArray(tool.input.todos) ? (tool.input.todos as any[]) : [];
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="todo-card">
      <div className="todo-head">
        <ListTodo size={15} /> Aufgaben <span className="todo-count">{done}/{todos.length}</span>
      </div>
      {todos.map((t, i) => (
        <div key={i} className={`todo ${t.status}`}>
          {t.status === 'completed' ? <CircleCheck size={15} /> : t.status === 'in_progress' ? <CircleDot size={15} /> : <Circle size={15} />}
          <span>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </div>
      ))}
    </div>
  );
}

/** One step: a short line, details on click. */
export function StepRow({ tool, running }: { tool: Tool; running: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = iconFor(tool.name);
  const pending = !tool.result;
  const agent = tool.name === 'Task' || tool.name === 'Agent';
  return (
    <div className={`step${tool.result?.error ? ' error' : ''}${open ? ' open' : ''}`}>
      <button className="step-head" onClick={() => setOpen(!open)}>
        {pending && running ? <span className="mark working" style={{ width: 13, height: 13 }} /> : <Icon size={14} />}
        <span className="step-text">{tool.summary}</span>
        {tool.result?.error && <span className="tag deleted">Fehler</span>}
        <ChevronRight size={13} className={`chev${open ? ' rot' : ''}`} />
      </button>
      {open && (
        <div className="step-body">
          {(tool.name === 'Bash' || tool.name === 'PowerShell') && <pre className="tool-cmd">{str(tool.input.command)}</pre>}
          {!['Bash', 'PowerShell'].includes(tool.name) && !agent && (
            <pre className="tool-cmd">{Object.entries(tool.input).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}</pre>
          )}
          {agent && str(tool.input.prompt) && <div className="tool-prompt">{str(tool.input.prompt)}</div>}
          {tool.result &&
            (agent ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(tool.result.text) }} />
            ) : tool.result.text ? (
              <pre className="tool-out">{tool.result.text}</pre>
            ) : tool.result.images ? (
              <div className="tool-note">{tool.result.images === 1 ? 'Ein Bild' : `${tool.result.images} Bilder`}</div>
            ) : (
              <div className="tool-note">Keine Ausgabe</div>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * A subagent: its own card with what it is doing right now (its newest steps, live), and on click
 * the task it got, all its steps and its answer.
 */
export function AgentCard({ tool, running }: { tool: Tool; running: boolean }) {
  const a = tool.agent;
  const live = a ? !a.done : running && !tool.result;
  const [open, setOpen] = useState(false);
  const description = a?.description || str(tool.input.description) || 'Agent';
  const type = a?.type || str(tool.input.subagent_type);
  const steps = a?.steps ?? [];
  const shown = open ? steps : live ? steps.slice(-3) : [];
  const total = a?.total ?? 0;
  // A background agent's call answers right away ("launched"); its real answer comes later.
  const answer = tool.result && !/^Async agent launched/i.test(tool.result.text) ? tool.result : null;
  return (
    <div className={`agent-card${live ? ' live' : ''}${tool.result?.error ? ' error' : ''}${open ? ' open' : ''}`}>
      <button className="agent-head" onClick={() => setOpen(!open)}>
        {live ? <span className="mark working" style={{ width: 14, height: 14 }} /> : <Bot size={15} />}
        <span className="agent-title">{description}</span>
        {type && type !== 'general-purpose' && <span className="agent-type">{type}</span>}
        <span className="agent-state">
          {live ? 'arbeitet' : tool.result?.error ? 'Fehler' : 'fertig'}
          {total > 0 && ` · ${total} ${total === 1 ? 'Schritt' : 'Schritte'}`}
        </span>
        <ChevronRight size={13} className={`chev${open ? ' rot' : ''}`} />
      </button>
      {shown.length > 0 && (
        <div className="agent-steps">
          {open && total > steps.length && <div className="agent-more">{total - steps.length} frühere Schritte</div>}
          {shown.map((s, i) => {
            const Icon = iconFor(s.name);
            const current = live && i === shown.length - 1;
            return (
              <div key={total - shown.length + i} className={`agent-step${s.error ? ' error' : ''}${current ? ' current' : ''}`}>
                <Icon size={13} />
                <span>{s.summary}</span>
              </div>
            );
          })}
        </div>
      )}
      {live && !open && a?.said && steps.length === 0 && <div className="agent-said">{a.said}</div>}
      {open && (
        <div className="agent-body">
          {str(tool.input.prompt) && (
            <>
              <div className="agent-label">Auftrag</div>
              <div className="tool-prompt">{str(tool.input.prompt)}</div>
            </>
          )}
          {answer && (
            <>
              <div className="agent-label">Ergebnis</div>
              <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(answer.text) }} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
