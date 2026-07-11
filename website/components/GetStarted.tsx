import Shot from './Shot';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';

export default function GetStarted({ d, lang }: { d: Dictionary['getStarted']; lang: Locale }) {
  return (
    <section id="start">
      <div className="wrap">
        <div className="col reveal">
          <p className="eyebrow">{d.eyebrow}</p>
          <h2>{d.h2}</h2>
          <p className="sec-lead">{d.lead}</p>
        </div>
        <div className="steps">
          {d.steps.map((s) => (
            <div className="step reveal" key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 34 }}>
          <Shot src={`/assets/${lang}/login.jpg`} alt={d.shotAlt} label={d.shotLabel} width={1320} height={984} />
        </div>
        <figcaption>{d.figcaption}</figcaption>
      </div>
    </section>
  );
}
