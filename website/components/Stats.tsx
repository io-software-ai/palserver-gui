'use client';

import { useEffect, useRef } from 'react';
import type { Dictionary } from '@/i18n/dictionaries';

const VALUES: (number | 'free')[] = [0, 13, 3, 'free'];

/** 數字帶:進入視野時 count-up + 依序彈入。預渲染 HTML 直接是最終數值, SEO 不受影響。 */
export default function Stats({ d }: { d: Dictionary['stats'] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !('IntersectionObserver' in window)
    ) {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          const el = e.target as HTMLElement;
          const target = Number(el.dataset.target);
          const t0 = performance.now();
          const dur = 900;
          const tick = (t: number) => {
            const p = Math.min(1, (t - t0) / dur);
            el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.4 },
    );
    root.querySelectorAll<HTMLElement>('b[data-target]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <section aria-label="key numbers">
      <div className="wrap">
        <div className="stats reveal" ref={ref}>
          {VALUES.map((v, i) => (
            <div className="stat" key={i}>
              {typeof v === 'number' ? <b data-target={v}>{v}</b> : <b>{d.free}</b>}
              <span>{d.labels[i]}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
