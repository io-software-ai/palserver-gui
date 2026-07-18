'use client';

import { useEffect, useRef } from 'react';
import type { Dictionary } from '@/i18n/dictionaries';

const STATS_URL = 'https://stats.iosoftware.ai/api/stats';
/** 第 3 個數字接 worker 的 serverStarts:SSR 先給近期快照(SEO / 無 JS 也有數字),
 *  client 端再抓即時值更新。其餘為固定文案數字。 */
const VALUES: ({ n: number; live?: string } | 'free')[] = [
  { n: 0 },
  { n: 13 },
  { n: 86157, live: 'serverStarts' },
  'free',
];

/** 緊湊記數:>=100 萬用 M、>=1000 用 K(26755 -> 27K),其餘原樣。
 *  server / client 一致、無 locale,避免 hydration 不合。 */
const fmt = (n: number) =>
  n >= 1e6
    ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    : n >= 1000
      ? Math.round(n / 1000) + 'K'
      : String(n);

/** 數字帶:進入視野時 count-up + 依序彈入。預渲染 HTML 直接是最終數值, SEO 不受影響。 */
export default function Stats({ d }: { d: Dictionary['stats'] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let io: IntersectionObserver | undefined;

    const setupCountUp = () => {
      if (
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        !('IntersectionObserver' in window)
      ) {
        return;
      }
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io!.unobserve(e.target);
            const el = e.target as HTMLElement;
            const target = Number(el.dataset.target);
            const t0 = performance.now();
            const dur = 900;
            const tick = (t: number) => {
              const p = Math.min(1, (t - t0) / dur);
              el.textContent = fmt(Math.round(target * (1 - Math.pow(1 - p, 3))));
              if (p < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
        },
        { threshold: 0.4 },
      );
      root.querySelectorAll<HTMLElement>('b[data-target]').forEach((el) => io!.observe(el));
    };

    // 先抓即時 serverStarts 更新 data-target,再啟動 count-up(這樣會 count 到即時值)。
    fetch(STATS_URL)
      .then((r) => r.json())
      .then((s: Record<string, unknown>) => {
        root.querySelectorAll<HTMLElement>('b[data-live]').forEach((el) => {
          const v = s?.[el.dataset.live!];
          if (typeof v === 'number' && v > 0) {
            el.dataset.target = String(v);
            el.textContent = fmt(v);
          }
        });
      })
      .catch(() => {})
      .finally(setupCountUp);

    return () => io?.disconnect();
  }, []);

  return (
    <section aria-label="key numbers">
      <div className="wrap">
        <div className="stats reveal" ref={ref}>
          {VALUES.map((v, i) => (
            <div className="stat" key={i}>
              {v === 'free' ? (
                <b>{d.free}</b>
              ) : (
                <b data-target={v.n} {...(v.live ? { 'data-live': v.live } : {})}>
                  {fmt(v.n)}
                </b>
              )}
              <span>{d.labels[i]}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
