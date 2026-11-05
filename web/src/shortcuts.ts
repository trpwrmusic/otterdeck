// App-wide keyboard shortcuts. They work even while the terminal has focus.
// Ctrl+Shift avoids clashes with Claude Code (Alt+…) and AltGr on German keyboards (Ctrl+Alt).

export type ShortcutAction =
  | { type: 'next-attention' }
  | { type: 'project'; delta: 1 | -1 }
  | { type: 'new-claude' }
  | { type: 'new-shell' }
  | { type: 'tab-index'; index: number }
  | { type: 'tab'; delta: 1 | -1 }
  | { type: 'toggle-view' }
  | { type: 'palette' };

export function shortcutFor(e: KeyboardEvent): ShortcutAction | null {
  // Ctrl+K opens the command palette from anywhere, the terminal included.
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyK') return { type: 'palette' };
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  switch (e.code) {
    case 'KeyJ':
      return { type: 'next-attention' };
    case 'ArrowUp':
      return { type: 'project', delta: -1 };
    case 'ArrowDown':
      return { type: 'project', delta: 1 };
    case 'ArrowLeft':
      return { type: 'tab', delta: -1 };
    case 'ArrowRight':
      return { type: 'tab', delta: 1 };
    case 'Enter':
      return { type: 'new-claude' };
    case 'Backquote':
      return { type: 'new-shell' };
    case 'Space':
      return { type: 'toggle-view' };
  }
  const m = e.code.match(/^Digit([1-9])$/);
  if (m) return { type: 'tab-index', index: Number(m[1]) - 1 };
  return null;
}

export const isAppShortcut = (e: KeyboardEvent) => shortcutFor(e) !== null;
