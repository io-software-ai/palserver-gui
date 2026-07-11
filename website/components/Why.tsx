import type { Dictionary } from '@/i18n/dictionaries';

export default function Why({ d }: { d: Dictionary['why'] }) {
  return (
    <section>
      <div className="wrap col reveal">
        <p className="eyebrow">{d.eyebrow}</p>
        <h2>{d.h2}</h2>
        <p className="sec-lead">{d.lead}</p>
      </div>
    </section>
  );
}
