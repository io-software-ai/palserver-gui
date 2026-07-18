'use client';

import { useEffect, useState, type MouseEventHandler, type ReactNode } from 'react';

/** release 資產名固定不含版本號,GitHub 的 latest/download 永久連結會自動指到最新版。 */
const RELEASES = 'https://github.com/io-software-ai/palserver-gui/releases';
const LATEST = 'https://github.com/io-software-ai/palserver-gui/releases/latest/download/';
const ASSETS = {
  windows: 'palserver-agent-windows.zip',
  // mac/linux 用 tar.gz:zip 不保留執行權限
  macos: 'palserver-agent-macos.tar.gz',
  linux: 'palserver-agent-linux.tar.gz',
} as const;
type Os = keyof typeof ASSETS;
const OS_LABEL: Record<Os, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

/** 桌面平台偵測;行動裝置與未知平台回 null → 連到 releases 總覽頁自選。 */
function detectOs(): Os | null {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return null;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}

/** 下載按鈕:依訪客平台直連最新版對應資產。SSR 與未知平台維持 releases 頁,水合後才增強。 */
export default function DownloadLink({
  className,
  children,
  onClick,
}: {
  className?: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const [os, setOs] = useState<Os | null>(null);
  useEffect(() => setOs(detectOs()), []);
  return (
    <a
      className={className}
      href={os ? LATEST + ASSETS[os] : RELEASES}
      onClick={onClick}
      data-dl-os={os ?? undefined}
    >
      {children}
      {os && <span className="dl-os">{OS_LABEL[os]}</span>}
    </a>
  );
}
