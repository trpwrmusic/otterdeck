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
