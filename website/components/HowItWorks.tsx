import type { Dictionary } from '@/i18n/dictionaries';

export default function HowItWorks({ d }: { d: Dictionary['how'] }) {
  return (
    <section id="how" className="band">
      <div className="wrap">
        <div className="col reveal">
          <p className="eyebrow">{d.eyebrow}</p>
          <h2>{d.h2}</h2>
          <p className="sec-lead">{d.lead}</p>
        </div>
        <div className="arch reveal">
          <div className="node">
            <div className="nt">{d.deviceTitle}</div>
            <div className="nd">{d.deviceDesc}</div>
          </div>
          <div className="node mid">
            <div className="mid-in">
              <div className="flow" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
              {d.midLine1}
              <br />
              {d.midLine2}
            </div>
          </div>
          <div className="node">
            <div className="nt">{d.serverTitle}</div>
            <div className="nd">{d.serverDesc}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
