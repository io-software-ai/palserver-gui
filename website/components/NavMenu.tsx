'use client';

import { useEffect, useState } from 'react';
import { GitHubIcon } from './icons';
import LangSwitch from './LangSwitch';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';

/**
 * 手機版導覽:漢堡按鈕 + 下拉面板。桌機隱藏(CSS),手機顯示。
 * 面板收納連結、語言切換、GitHub / 下載,logo「palserver GUI」字樣則永遠留在列上。
 * 靜態匯出沒有 router,用 useState 控制開合,點連結 / 按 Esc / 點面板外都會關閉。
 */
export default function NavMenu({ d, lang }: { d: Dictionary['nav']; lang: Locale }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element)?.closest('.menu')) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="menu">
      <button
        type="button"
        className="burger"
        aria-label="Menu"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span />
        <span />
        <span />
      </button>
      <div className={open ? 'panel open' : 'panel'}>
        <a href="#features" onClick={close}>
          {d.features}
        </a>
        <a href="#how" onClick={close}>
          {d.how}
        </a>
        <a href="#start" onClick={close}>
          {d.start}
        </a>
        <a href="#team" onClick={close}>
          {d.team}
        </a>
        <div className="pdiv" />
        <LangSwitch current={lang} />
        <a
          className="btn btn-g"
          href="https://github.com/io-software-ai/palserver-gui"
          onClick={close}
        >
          <GitHubIcon />
          {d.github}
        </a>
        <a
          className="btn btn-p"
          href="https://github.com/io-software-ai/palserver-gui/releases"
          onClick={close}
        >
          {d.download}
        </a>
      </div>
    </div>
  );
}
