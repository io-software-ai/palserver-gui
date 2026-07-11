'use client';

import { useEffect } from 'react';

/**
 * 根路由「/」依瀏覽器語言導向對應語系,沒有相符的一律預設繁中(/zh/)。掃整個
 * navigator.languages 清單(不只主要語言),保留使用者原本要去的錨點。這個檔在
 * next dev 與靜態匯出都會被 serve(取代原本只在靜態主機生效的 public/index.html)。
 */
export default function RootRedirect() {
  useEffect(() => {
    const prefs =
      navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'zh'];
    let target = 'zh';
    for (const raw of prefs) {
      const l = String(raw).toLowerCase();
      if (l.indexOf('ja') === 0) { target = 'ja'; break; }
      if (l.indexOf('en') === 0) { target = 'en'; break; }
      if (l.indexOf('zh') === 0) { target = 'zh'; break; }
    }
    window.location.replace('/' + target + '/' + window.location.hash);
  }, []);
  return null;
}
