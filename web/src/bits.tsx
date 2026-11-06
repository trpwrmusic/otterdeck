import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { ProjectView } from '../../shared/types';
import type { Attention } from './api';

/** Small status mark: spinning ring (working), dot (waiting), check (done, unseen). */
export function StatusMark({ attention, size = 14 }: { attention: Attention; size?: number }) {
  if (attention === 'working') return <span className="mark working" style={{ width: size, height: size }} aria-label="Arbeitet" />;
  if (attention === 'waiting') return <span className="mark waiting" style={{ width: size - 4, height: size - 4 }} aria-label="Wartet auf dich" />;
  if (attention === 'done')
    return (
      <span className="mark done" aria-label="Fertig">
        <Check size={size - 2} strokeWidth={2.6} />
      </span>
    );
  return null;
}

export function ProjectAvatar({ project, size = 30 }: { project: ProjectView; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const letter = project.displayName.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '·';
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.46, borderRadius: size * 0.28 }}>
      {project.icon && failed !== project.icon ? (
        <img
          src={`/api/projects/${project.id}/icon?v=${encodeURIComponent(project.icon)}`}
          alt=""
          onError={() => setFailed(project.icon)}
          draggable={false}
        />
      ) : (
        letter
      )}
    </span>
  );
}

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  checked?: boolean;
  hint?: string;
  /** Asks once more before running onClick. */
  confirm?: string;
  separatorBefore?: boolean;
  disabled?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, innerWidth - r.width - 8), y: Math.min(y, innerHeight - r.height - 8) });
    const down = (e: MouseEvent) => !el.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
    };
  }, [x, y, onClose]);

  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) => (
        <div key={i}>
          {it.separatorBefore && <div className="menu-gap" />}
          <button
            className={`menu-item${it.danger ? ' danger' : ''}${armed === i ? ' armed' : ''}`}
            disabled={it.disabled}
            role="menuitem"
            onClick={() => {
              if (it.confirm && armed !== i) return setArmed(i);
              onClose();
              it.onClick?.();
            }}
          >
            <span className="menu-check">{it.checked ? <Check size={14} strokeWidth={2.4} /> : null}</span>
            <span className="menu-label">{armed === i && it.confirm ? it.confirm : it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export interface DropdownItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  /** Starts a new group (a little space above). */
  separatorBefore?: boolean;
  onClick: () => void;
}

/**
 * A dropdown anchored under a button (right-aligned), for mouse and finger alike: icons, roomy rows,
 * opens from its corner. `anchor` is the button's rectangle.
 */
export function Dropdown({ anchor, items, onClose }: { anchor: DOMRect; items: DropdownItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Wait a tick so the tap that opened it doesn't close it again.
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', down);
    }, 0);
    // A tap on its own button is left to the button (it toggles), anything else outside closes.
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('[data-dropdown-anchor]')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // No closing on resize: on Android the address bar alone resizes the window.
    window.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const right = Math.max(8, window.innerWidth - anchor.right);
  return (
    <div className="dropdown" ref={ref} role="menu" style={{ top: anchor.bottom + 8, right }}>
      {items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          className={`dropdown-item${it.danger ? ' danger' : ''}${it.separatorBefore ? ' sep' : ''}`}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.icon && <span className="dropdown-icon">{it.icon}</span>}
          <span className="dropdown-text">
            <span className="dropdown-label">{it.label}</span>
            {it.hint && <span className="dropdown-hint">{it.hint}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
