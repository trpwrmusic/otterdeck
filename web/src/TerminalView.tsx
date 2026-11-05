import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { TabView, TermServerMsg } from '../../shared/types';
import { api, termUrl } from './api';
import { isAppShortcut } from './shortcuts';

const DARK: ITheme = {
  background: '#121214',
  foreground: '#e6e6e8',
  cursor: '#ededee',
  cursorAccent: '#121214',
  selectionBackground: 'rgba(255,255,255,0.16)',
  black: '#1f1f22',
  red: '#e0786e',
  green: '#9cc48a',
  yellow: '#e2bf72',
  blue: '#82a8d8',
  magenta: '#c49ad8',
  cyan: '#7fc0bc',
  white: '#d8d2ca',
  brightBlack: '#6f6f76',
  brightRed: '#ee8d83',
  brightGreen: '#b2d6a0',
  brightYellow: '#ecd08e',
  brightBlue: '#9dbde6',
  brightMagenta: '#d4b0e4',
  brightCyan: '#97d2ce',
  brightWhite: '#f6f2ec',
};

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1c2324',
  cursor: '#1b6c80',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(27,108,128,0.18)',
  black: '#1c2324',
  red: '#c0453a',
  green: '#4f8a3c',
  yellow: '#9b7414',
  blue: '#3b6db0',
  magenta: '#8a4fa8',
  cyan: '#2f8580',
  white: '#d9d3cc',
  brightBlack: '#6f6f76',
  brightRed: '#d5594e',
  brightGreen: '#5f9d4b',
  brightYellow: '#b38a22',
  brightBlue: '#4d80c4',
  brightMagenta: '#9d62bb',
  brightCyan: '#3a9893',
  brightWhite: '#f7f4f0',
};

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function TerminalView({ tab, active }: { tab: TabView; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [exited, setExited] = useState<{ code: number | null } | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: DARK,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // DOM renderer is fine as a fallback.
    }

    // Windows habits: Ctrl+C copies when text is selected, Ctrl+V pastes.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (isAppShortcut(e)) return false;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'v') return false; // browser fires a paste event
      return true;
    });

    const onScheme = () => (term.options.theme = DARK);
    darkQuery.addEventListener('change', onScheme);

    let ws: WebSocket | null = null;
    let closed = false;
    let retry: number | undefined;
    const send = (msg: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

    const connect = () => {
      ws = new WebSocket(termUrl(tab.id));
      ws.onopen = () => {
        setOffline(false);
        fit.fit();
        send({ t: 'resize', cols: term.cols, rows: term.rows });
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as TermServerMsg;
        if (msg.t === 'snapshot') {
          term.reset();
          term.write(msg.d);
          setExited(null);
        } else if (msg.t === 'out') term.write(msg.d);
        else if (msg.t === 'exit') setExited({ code: msg.code });
      };
      ws.onclose = (e) => {
        if (closed || e.code === 4404) return;
        setOffline(true);
        retry = window.setTimeout(connect, 1000);
      };
    };
    connect();

    const data = term.onData((d) => send({ t: 'in', d }));
    const bin = term.onBinary((d) => send({ t: 'in', d }));

    let resizeTimer: number | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!el.offsetWidth || !el.offsetHeight) return;
        const before = `${term.cols}x${term.rows}`;
        fit.fit();
        if (`${term.cols}x${term.rows}` !== before) send({ t: 'resize', cols: term.cols, rows: term.rows });
      }, 40);
    });
    ro.observe(el);

    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(resizeTimer);
      ro.disconnect();
      darkQuery.removeEventListener('change', onScheme);
      data.dispose();
      bin.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [tab.id]);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active, exited]);

  const isClaude = tab.kind === 'claude';
  return (
    <div className="term-wrap">
      <div className="term" ref={host} />
      {exited && (
        <div className="term-overlay">
          <div className="overlay-card">
            <div className="overlay-title">{isClaude ? 'Claude wurde beendet' : 'Die Shell wurde beendet'}</div>
            <div className="overlay-actions">
              {isClaude && tab.claudeSessionId && (
                <button className="btn primary" onClick={() => api.restartTab(tab.id)}>
                  Gespräch fortsetzen
                </button>
              )}
              <button
                className={isClaude && tab.claudeSessionId ? 'btn' : 'btn primary'}
                onClick={() => api.restartTab(tab.id, true)}
              >
                {isClaude ? 'Neues Gespräch' : 'Neu starten'}
              </button>
              <button className="btn quiet" onClick={() => api.closeTab(tab.id)}>
                Tab schließen
              </button>
            </div>
          </div>
        </div>
      )}
      {offline && !exited && <div className="term-offline">Verbindung zu Otterdeck getrennt …</div>}
    </div>
  );
}
