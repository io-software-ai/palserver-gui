import { GitHubIcon } from './icons';
import DownloadLink from './DownloadLink';
import LangSwitch from './LangSwitch';
import NavMenu from './NavMenu';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';

export default function Nav({ d, lang }: { d: Dictionary['nav']; lang: Locale }) {
  return (
    <nav aria-label="primary">
      <div className="in">
        <a className="logo" href="#top">
          <span className="m">
            <img src="/assets/logo.png" alt="" width={30} height={30} />
          </span>
          <span className="lt">palserver GUI</span>
        </a>
        <div className="links">
          <a href="#features">{d.features}</a>
          <a href="#how">{d.how}</a>
          <a href="#start">{d.start}</a>
          <a href="#team">{d.team}</a>
          <a href={`/${lang}/changelog/`}>{d.changelog}</a>
        </div>
        <div className="sp" />
        {/* 桌機:一整排控制項;手機隱藏,改由 NavMenu 漢堡收納 */}
        <div className="navctl">
          <LangSwitch current={lang} />
          <a className="btn btn-g btn-sm" href="https://github.com/io-software-ai/palserver-gui">
            <GitHubIcon />
            {d.github}
          </a>
          <DownloadLink className="btn btn-p btn-sm">{d.download}</DownloadLink>
        </div>
        <NavMenu d={d} lang={lang} />
      </div>
    </nav>
  );
}
