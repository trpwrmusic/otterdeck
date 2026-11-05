import { useEffect, useState } from 'react';
import { CornerDownLeft, SquareTerminal } from 'lucide-react';
import type { PromptView, TabView } from '../../../shared/types';
import { api } from '../api';

// Claude Code asks in English; the common phrases read better in German.
export function germanQuestion(p: PromptView): string {
  const q = p.question.trim();
  if (/^Do you want to proceed\?$/i.test(q)) return 'Darf Claude das ausführen?';
  let m = q.match(/^Do you want to create (.+)\?$/i);
  if (m) return `Darf Claude ${m[1]} anlegen?`;
  m = q.match(/^Do you want to make this edit to (.+)\?$/i);
  if (m) return `Darf Claude ${m[1]} ändern?`;
  m = q.match(/^Do you want to (?:allow|fetch|read) (.+)\?$/i);
  if (m) return `Darf Claude ${m[1]} öffnen?`;
  return q;
}

export function germanLabel(label: string): string {
  if (/^yes$/i.test(label)) return 'Ja';
  if (/^no$/i.test(label)) return 'Nein';
  if (/^type something\.?$/i.test(label)) return 'Eigene Antwort';
  return label.replace(/^Yes, and /i, 'Ja, und ').replace(/^No, and /i, 'Nein, und ');
}

const TITLES: Record<string, string> = {
  'bash command': 'Befehl',
  'create file': 'Neue Datei',
  'edit file': 'Datei ändern',
  'fetch': 'Webseite',
};

/**
 * A dialog Claude shows in the terminal, as a card: the real options as buttons, digits as shortcuts,
 * a text field for "Type something.". Picking one moves the cursor there in the terminal and presses Enter.
 */
export function PromptCard({ tab, prompt, onShowTerminal }: { tab: TabView; prompt: PromptView; onShowTerminal: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');

  const pick = async (n: number, answer?: string) => {
    if (busy !== null) return;
    setBusy(n);
    try {
      await api.choose(tab.id, n, answer);
    } finally {
      setTimeout(() => setBusy(null), 600);
    }
  };

  // 1-9 pick an option while nothing else has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const inField = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && (el as HTMLInputElement).value;
      if (typing || inField || e.ctrlKey || e.altKey || e.metaKey) return;
      const n = Number(e.key);
      const o = prompt.options.find((x) => x.n === n);
      if (!o) return;
      e.preventDefault();
      if (o.n === prompt.freeText) setTyping(true);
      else pick(o.n);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const isQuestion = prompt.kind === 'question';
  const title = prompt.title ? TITLES[prompt.title.toLowerCase()] ?? prompt.title : null;

  return (
    <div className={`ask-card prompt ${prompt.kind}`}>
      {title && <div className="ask-title">{title}</div>}
      {prompt.detail && <pre className="ask-detail">{prompt.detail}</pre>}
      <div className="ask-q">{germanQuestion(prompt)}</div>
      <div className={`ask-options${isQuestion || prompt.options.length > 2 ? ' list' : ''}`}>
        {prompt.options.map((o, i) => {
          const free = o.n === prompt.freeText;
          if (free && typing)
            return (
              <form
                key={o.n}
                className="ask-free"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (text.trim()) pick(o.n, text.trim());
                }}
              >
                <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Deine Antwort" onKeyDown={(e) => e.key === 'Escape' && setTyping(false)} />
                <button className="btn small primary" disabled={!text.trim() || busy !== null}>
                  <CornerDownLeft size={14} /> Senden
                </button>
              </form>
            );
          return (
            <button
              key={o.n}
              className={`ask-option${i === 0 && !isQuestion ? ' first' : ''}${busy === o.n ? ' busy' : ''}`}
              disabled={busy !== null}
              onClick={() => (free ? setTyping(true) : pick(o.n))}
            >
              <span className="ask-num">{o.n}</span>
              <span className="ask-label">
                {germanLabel(o.label)}
                {o.description && <span className="ask-desc">{o.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <button className="ask-terminal" onClick={onShowTerminal}>
        <SquareTerminal size={13} /> Im Terminal ansehen
      </button>
    </div>
  );
}
