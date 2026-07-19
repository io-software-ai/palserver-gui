import Shot from './Shot';
import DownloadLink from './DownloadLink';
import DiscordPresence from './DiscordPresence';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';

export default function Hero({
  d,
  lang,
  discord,
}: {
  d: Dictionary['hero'];
  lang: Locale;
  discord: Dictionary['discord'];
}) {
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
          <DownloadLink className="btn btn-p">{d.ctaDownload}</DownloadLink>
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
          <span className="chip">
            <DiscordPresence d={discord} />
          </span>
        </div>
        <div className="hero-shot">
          <Shot src={`/assets/${lang}/content.png`} alt={d.shotAlt} label={d.shotLabel} width={1320} height={848} priority />
        </div>
      </div>
    </header>
  );
}
