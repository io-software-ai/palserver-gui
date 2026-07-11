import Nav from '@/components/Nav';
import Hero from '@/components/Hero';
import Stats from '@/components/Stats';
import Why from '@/components/Why';
import HowItWorks from '@/components/HowItWorks';
import Features from '@/components/Features';
import Audience from '@/components/Audience';
import Wishes from '@/components/Wishes';
import GetStarted from '@/components/GetStarted';
import NiceDetails from '@/components/NiceDetails';
import Team from '@/components/Team';
import ClosingCta from '@/components/ClosingCta';
import Footer from '@/components/Footer';
import RevealObserver from '@/components/RevealObserver';
import { isLocale, defaultLocale, type Locale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang: raw } = await params;
  const lang: Locale = isLocale(raw) ? raw : defaultLocale;
  const d = getDictionary(lang);

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: d.wishes.items.map((w) => ({
      '@type': 'Question',
      name: w.q,
      acceptedAnswer: { '@type': 'Answer', text: `${w.head}${w.body}` },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div className="prog" aria-hidden="true" />
      <div className="bg" aria-hidden="true">
        <i className="a" />
        <i className="b" />
      </div>
      <Nav d={d.nav} lang={lang} />
      <Hero d={d.hero} lang={lang} />
      <main>
        <Stats d={d.stats} />
        <Why d={d.why} />
        <HowItWorks d={d.how} />
        <Features d={d.features} lang={lang} />
        <Audience d={d.audience} />
        <Wishes d={d.wishes} />
        <GetStarted d={d.getStarted} lang={lang} />
        <NiceDetails d={d.niceDetails} lang={lang} />
        <Team d={d.team} />
        <ClosingCta d={d.closing} />
      </main>
      <Footer d={d.footer} />
      <RevealObserver />
    </>
  );
}
