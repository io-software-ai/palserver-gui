import type { Metadata, Viewport } from 'next';
import { locales, isLocale, defaultLocale, htmlLang, ogLocale, alternateLanguages, type Locale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';

const SITE_URL = 'https://palserver-gui.iosoftware.ai';

export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang: raw } = await params;
  const lang: Locale = isLocale(raw) ? raw : defaultLocale;
  const d = getDictionary(lang);
  const title = d.meta.title;
  const description = d.meta.description;

  return {
    metadataBase: new URL(SITE_URL),
    title: { default: title, template: '%s — palserver GUI' },
    description,
    keywords: [
      '帕魯伺服器',
      '帕魯開服',
      '帕魯專用伺服器',
      'Palworld 伺服器',
      'Palworld dedicated server',
      'Palworld server manager',
      'Palworld サーバー',
      '開服工具',
      'palserver GUI',
      '免費開源',
    ],
    authors: [{ name: 'Eason Lu (Dalufish)', url: 'https://github.com/Dalufishe' }],
    creator: 'io software',
    publisher: 'io software',
    alternates: { canonical: `/${lang}/`, languages: alternateLanguages },
    openGraph: {
      type: 'website',
      url: `${SITE_URL}/${lang}/`,
      siteName: 'palserver GUI',
      locale: ogLocale[lang],
      title,
      description,
      images: [{ url: `/assets/${lang}/overview.jpg`, width: 1320, height: 848, alt: d.meta.ogAlt }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [`/assets/${lang}/overview.jpg`] },
    robots: {
      index: true,
      follow: true,
      googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 },
    },
    category: 'technology',
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#7A5FCF' },
    { media: '(prefers-color-scheme: dark)', color: '#201C2C' },
  ],
};

export default async function LangLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang: raw } = await params;
  const lang: Locale = isLocale(raw) ? raw : defaultLocale;
  const d = getDictionary(lang);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#app`,
        name: 'palserver GUI',
        description: d.meta.description,
        url: `${SITE_URL}/${lang}`,
        applicationCategory: 'GameApplication',
        operatingSystem: 'Windows, Linux',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'TWD' },
        downloadUrl: 'https://github.com/io-software-ai/palserver-gui/releases',
        softwareVersion: '2.0',
        inLanguage: ['zh-Hant', 'en', 'ja'],
        screenshot: `${SITE_URL}/assets/${lang}/overview.jpg`,
        license: 'https://polyformproject.org/licenses/noncommercial/1.0.0/',
        author: { '@id': `${SITE_URL}/#org` },
      },
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#org`,
        name: 'io software',
        url: 'https://iosoftware.ai',
        logo: `${SITE_URL}/assets/iosoftware-logo.svg`,
        email: 'contact@iosoftware.ai',
        sameAs: ['https://github.com/io-software-ai', 'https://www.instagram.com/iosoftware.ai/'],
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#site`,
        name: 'palserver GUI',
        url: `${SITE_URL}/${lang}`,
        inLanguage: htmlLang[lang],
        publisher: { '@id': `${SITE_URL}/#org` },
      },
    ],
  };

  return (
    <>
      {/* 根 layout 的 <html lang> 預設繁中,這裡依語系即時修正(parse 時就跑,先於水合)。 */}
      <script dangerouslySetInnerHTML={{ __html: `document.documentElement.lang=${JSON.stringify(htmlLang[lang])}` }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      {children}
    </>
  );
}
