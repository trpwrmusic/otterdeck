import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * A highlight that glides to the active item instead of jumping. Put it inside the container
 * (position: relative) that holds the items; the active one matches `selector`.
 * It re-measures after every render and whenever rows move or the container resizes.
 */
export function Glide({ selector, className = '' }: { selector: string; watch?: unknown[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  const place = useCallback(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const target = box.querySelector<HTMLElement>(selector);
    if (!target || !target.offsetWidth) {
      el.style.opacity = '0';
      return;
    }
    // Measured on screen, relative to the container's content (scroll included), so nesting doesn't matter.
    const b = box.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const x = t.left - b.left + box.scrollLeft - box.clientLeft;
    const y = t.top - b.top + box.scrollTop - box.clientTop;
    const next = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (el.style.transform === next && el.style.width === `${t.width}px` && el.style.opacity === '1') return;
    // The very first placement doesn't animate; every later one does.
    el.style.transition = first.current ? 'none' : '';
    el.style.opacity = '1';
    el.style.width = `${t.width}px`;
    el.style.height = `${t.height}px`;
    el.style.transform = next;
    first.current = false;
  }, [selector]);

  // After every render of the parent.
  useLayoutEffect(() => place());

  useEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) return;
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const ro = new ResizeObserver(later);
    ro.observe(box);
    const mo = new MutationObserver(later);
    mo.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [place]);

  return <div ref={ref} className={`glide ${className}`} aria-hidden />;
}
