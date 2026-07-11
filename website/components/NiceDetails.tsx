import Shot from './Shot';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';

export default function NiceDetails({ d, lang }: { d: Dictionary['niceDetails']; lang: Locale }) {
  return (
    <section className="band">
      <div className="wrap">
        <div className="col reveal">
          <p className="eyebrow">{d.eyebrow}</p>
          <h2>{d.h2}</h2>
          <p className="sec-lead">{d.lead}</p>
        </div>
        <Shot src={`/assets/${lang}/announcement.jpg`} alt={d.shotAlt} label={d.shotLabel} width={1320} height={984} />
      </div>
    </section>
  );
}
