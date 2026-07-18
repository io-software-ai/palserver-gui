import type { Metadata } from 'next';
import Footer from '@/components/Footer';
import ChangelogList from '@/components/ChangelogList';
import { locales, isLocale, defaultLocale, type Locale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';

export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang: raw } = await params;
  const lang: Locale = isLocale(raw) ? raw : defaultLocale;
  const d = getDictionary(lang);
  return { title: `${d.changelog.title} — palserver GUI`, description: d.changelog.sub };
}

export default async function ChangelogPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang: raw } = await params;
  const lang: Locale = isLocale(raw) ? raw : defaultLocale;
  const d = getDictionary(lang);

  return (
    <>
      <nav aria-label="primary">
        <div className="in">
          <a className="logo" href={`/${lang}/`}>
            <span className="m">
              <img src="/assets/logo.png" alt="" width={30} height={30} />
            </span>
            <span className="lt">palserver GUI</span>
          </a>
          <div className="sp" />
          <a className="btn btn-g btn-sm" href={`/${lang}/`}>
            ← {d.changelog.back}
          </a>
        </div>
      </nav>
      <main className="wrap chlog-page">
        <h1>{d.changelog.title}</h1>
        <p className="sec-lead">{d.changelog.sub}</p>
        <ChangelogList lang={lang} d={d.changelog} />
      </main>
      <Footer d={d.footer} />
    </>
  );
}
