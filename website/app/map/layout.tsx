import '../globals.css';
import './map.css';
import type { Metadata, Viewport } from 'next';

// /map 是任何人拿到分享連結就能看的公開唯讀地圖,不需要也不應該被搜尋引擎索引。
// 這個路由在 app/[lang] 之外(靜態段 /map 優先於 [lang] 動態段),沒有共用的
// 頂層 app/layout.tsx,所以跟 app/(root)/layout.tsx 一樣要自己提供 <html>/<body>。
export const metadata: Metadata = {
  title: 'palserver GUI — 公開地圖',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#7A5FCF' },
    { media: '(prefers-color-scheme: dark)', color: '#201C2C' },
  ],
};

export default function MapLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
