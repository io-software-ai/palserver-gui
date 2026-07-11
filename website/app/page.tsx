import type { Metadata } from 'next';
import RootRedirect from './RootRedirect';

// 「/」只是語言導向頁,不需要被索引;正式內容在 /zh、/en、/ja。
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  alternates: { canonical: '/zh/' },
};

export default function Page() {
  return (
    <>
      <noscript>
        <meta httpEquiv="refresh" content="0; url=/zh/" />
      </noscript>
      <RootRedirect />
      <p style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
        前往 palserver GUI… / Redirecting… <a href="/zh/">/zh/</a>
      </p>
    </>
  );
}
