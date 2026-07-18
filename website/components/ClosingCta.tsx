import { GitHubIcon } from './icons';
import DownloadLink from './DownloadLink';
import type { Dictionary } from '@/i18n/dictionaries';

export default function ClosingCta({ d }: { d: Dictionary['closing'] }) {
  return (
    <section>
      <div className="wrap">
        <div className="close reveal">
          <p className="eyebrow">{d.eyebrow}</p>
          <h2>{d.h2}</h2>
          <p className="sec-lead" style={{ margin: '0 auto 26px' }}>
            {d.lead}
          </p>
          <div className="cta" style={{ marginTop: 0 }}>
            <DownloadLink className="btn btn-p">{d.ctaDownload}</DownloadLink>
            <a className="btn btn-g" href="https://github.com/io-software-ai/palserver-gui">
              <GitHubIcon />
              GitHub
            </a>
            <a className="btn btn-g" href="https://discord.gg/sgMMdUZd3V">
              Discord
            </a>
          </div>
          <div className="note">
            {d.notePre}
            <a className="pal" style={{ fontWeight: 800 }} href="https://iosoftware.ai/server-maintain-service">
              {d.noteLink}
            </a>
            {d.notePost}
          </div>
        </div>
      </div>
    </section>
  );
}
