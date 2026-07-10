import Shot from './Shot';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';

export default function Hero({ d, lang }: { d: Dictionary['hero']; lang: Locale }) {
  return (
    <header id="top">
      <div className="wrap">
        <p className="eyebrow">{d.eyebrow}</p>
        <h1>
          <span className="pal">{d.h1Emph}</span>
          {d.h1Rest}
          <br />
          {d.h1Line2}
        </h1>
        <p className="sub">{d.sub}</p>
        <div className="cta">
          <a className="btn btn-p" href="https://github.com/io-software-ai/palserver-gui/releases">
            {d.ctaDownload}
          </a>
          <a className="btn btn-g" href="#features">
            {d.ctaLearn}
          </a>
        </div>
        <div className="chips">
          {d.chips.map((c, i) => (
            <span className="chip" key={i}>
              {c.plain ?? (
                <>
                  {c.lead}
                  {c.strong && <b>{c.strong}</b>}
                  {c.tail}
                </>
              )}
            </span>
          ))}
        </div>
        <div className="hero-shot">
          <Shot src={`/assets/${lang}/overview.jpg`} alt={d.shotAlt} label={d.shotLabel} width={1320} height={848} priority />
        </div>
      </div>
    </header>
  );
}
