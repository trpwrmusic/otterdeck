import { useLayoutEffect, useRef } from 'react';

/**
 * A highlight that glides to the active item instead of jumping. Put it inside the container
 * (position: relative) whose children carry the active class; `watch` lists what can move it.
 */
export function Glide({ selector, watch, className = '' }: { selector: string; watch: unknown[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const place = () => {
      const target = box.querySelector<HTMLElement>(selector);
      if (!target || !target.offsetWidth) {
        el.style.opacity = '0';
        return;
      }
      // The very first placement doesn't animate; every later one does.
      el.style.transition = first.current ? 'none' : '';
      el.style.opacity = '1';
      el.style.width = `${target.offsetWidth}px`;
      el.style.height = `${target.offsetHeight}px`;
      el.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop}px)`;
      first.current = false;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(box);
    for (const c of Array.from(box.children)) if (c !== el) ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, watch);

  return <div ref={ref} className={`glide ${className}`} aria-hidden />;
}
