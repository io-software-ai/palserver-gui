import { Check, RocketIcon, WrenchIcon } from './icons';
import type { Dictionary } from '@/i18n/dictionaries';

type Point = { head: string; body: string };

function AudienceCard({
  tag,
  title,
  icon,
  points,
}: {
  tag: string;
  title: string;
  icon: React.ReactNode;
  points: Point[];
}) {
  return (
    <div className="aud reveal">
      <p className="tag">{tag}</p>
      <h3>
        {icon} {title}
      </h3>
      <ul>
        {points.map((p) => (
          <li key={p.head}>
            <Check />
            <div>
              <b>{p.head}</b>
              <span> {p.body}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Audience({ d }: { d: Dictionary['audience'] }) {
  return (
    <section className="band">
      <div className="wrap">
        <div className="col reveal">
          <p className="eyebrow">{d.eyebrow}</p>
          <h2>{d.h2}</h2>
        </div>
        <div className="split">
          <AudienceCard tag={d.beginnerTag} title={d.beginnerTitle} icon={<RocketIcon />} points={d.beginner} />
          <AudienceCard tag={d.powerTag} title={d.powerTitle} icon={<WrenchIcon />} points={d.power} />
        </div>
      </div>
    </section>
  );
}
