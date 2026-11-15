import { useEffect, useState } from 'react';
import { Copy, CornerDownLeft, ExternalLink, SquareTerminal } from 'lucide-react';
import type { PromptView, TabView } from '../../../shared/types';
import { api } from '../api';

// Claude Code asks in English; the common phrases read better in German.
export function germanQuestion(p: PromptView): string {
  const q = p.question.trim();
  if (/^Do you want to proceed\?$/i.test(q)) return 'Darf Claude das ausführen?';
  // Antigravity (agy)
  if (/^Run this command\?$/i.test(q)) return 'Diesen Befehl ausführen?';
  if (/^Do you trust the contents of this project\?$/i.test(q)) return 'Vertraust du diesem Ordner?';
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
  // Antigravity (agy)
  if (/^yes, run command$/i.test(label)) return 'Ja, ausführen';
  if (/^no, cancel$/i.test(label)) return 'Nein, abbrechen';
  if (/^yes, i trust this folder$/i.test(label)) return 'Ja, ich vertraue dem Ordner';
  if (/^no, exit$/i.test(label)) return 'Nein, beenden';
  let m = label.match(/^Yes, and always allow in this conversation for commands that start with '(.+)'$/i);
  if (m) return `Ja, in diesem Gespräch immer: „${m[1]} …“`;
  m = label.match(/^Yes, and always allow for commands that start with '(.+)' \(Persist to settings\.json\)$/i);
  if (m) return `Ja, dauerhaft immer: „${m[1]} …“`;
  return label.replace(/^Yes, and /i, 'Ja, und ').replace(/^No, and /i, 'Nein, und ');
}

const TITLES: Record<string, string> = {
  'bash command': 'Befehl',
  'create file': 'Neue Datei',
  'edit file': 'Datei ändern',
  'fetch': 'Webseite',
  'requesting permission for:': 'Befehl',
  'accessing workspace:': 'Ordner',
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

/**
 * Claude Code's sign-in (login with a subscription): the link to open, and a field for the code the
 * sign-in page shows – so nobody has to go to the terminal for it, also from the phone.
 */
export function LoginCard({ tab, login, onShowTerminal }: { tab: TabView; login: NonNullable<TabView['login']>; onShowTerminal: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.loginCode(tab.id, code.trim());
      setCode('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ask-card prompt login-card">
      <div className="ask-title">Anmeldung</div>
      <div className="ask-q">Claude braucht deine Anmeldung.</div>
      <div className="login-steps">
        {login.code
          ? 'Öffne die Anmeldeseite, melde dich an und füg den Code, den sie dir zeigt, hier ein.'
          : 'Öffne die Anmeldeseite und melde dich an. Claude macht danach von selbst weiter.'}
      </div>
      <div className="login-actions">
        <a className="btn primary" href={login.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={15} /> Anmeldeseite öffnen
        </a>
        <button
          className="btn quiet"
          onClick={() => navigator.clipboard?.writeText(login.url).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
        >
          <Copy size={15} /> {copied ? 'Kopiert' : 'Link kopieren'}
        </button>
      </div>
      {login.code && (
        <form
          className="ask-free login-code"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) send();
          }}
        >
          <input value={code} spellCheck={false} autoComplete="one-time-code" onChange={(e) => setCode(e.target.value)} placeholder="Code einfügen" />
          <button className="btn small primary" disabled={!code.trim() || busy}>
            {busy ? 'Sende …' : 'Anmelden'}
          </button>
        </form>
      )}
      {error && <div className="login-error">{error}</div>}
      <button className="ask-terminal" onClick={onShowTerminal}>
        <SquareTerminal size={14} /> Im Terminal ansehen
      </button>
    </div>
  );
}
