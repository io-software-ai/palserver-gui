'use client';

import { useEffect } from 'react';

/** 進場動畫:把 .reveal 元素捲到視窗內時加上 .in。純加分效果, 沒有 JS 也看得到內容。 */
export default function RevealObserver() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
    const show = (el: HTMLElement) => el.classList.add('in');
    if (!('IntersectionObserver' in window)) {
      els.forEach(show);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            show(e.target as HTMLElement);
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0, rootMargin: '0px 0px -8% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
