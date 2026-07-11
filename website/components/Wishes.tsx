import { Check } from './icons';
import type { Dictionary } from '@/i18n/dictionaries';

export default function Wishes({ d }: { d: Dictionary['wishes'] }) {
  return (
    <section aria-label={d.h2}>
      <div className="wrap">
        <div className="col reveal">
          <p className="eyebrow">{d.eyebrow}</p>
          <h2>{d.h2}</h2>
          <p className="sec-lead">{d.lead}</p>
        </div>
        <div className="wishg">
          {d.items.map((w) => (
            <div className="wish reveal" key={w.q}>
              <div className="q">「{w.q}」</div>
              <div className="a">
                <Check />
                <span>
                  <b>{w.head}</b>
                  {w.body}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
