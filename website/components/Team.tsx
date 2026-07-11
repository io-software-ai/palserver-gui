import type { Dictionary } from '@/i18n/dictionaries';

/** 名字與頭像縮寫不翻譯;職稱由字典帶入(對應順序)。 */
const MEMBERS = [
  { av: 'D', name: 'Dalufish' },
  { av: 'M', name: 'Ming Chen' },
  { av: '1', name: '147' },
  { av: '墨', name: '墨殘' },
  { av: 'L', name: 'LilaS' },
  { av: '咖', name: '咖啡' },
];

export default function Team({ d }: { d: Dictionary['team'] }) {
  return (
    <section id="team">
      <div className="wrap">
        <div className="col reveal">
          <p className="eyebrow">{d.eyebrow}</p>
          <h2>{d.h2}</h2>
          <p className="sec-lead">{d.lead}</p>
        </div>
        <div className="teamg reveal">
          {MEMBERS.map((m, i) => (
            <div className="mem" key={m.name}>
              <div className="av" aria-hidden="true">
                {m.av}
              </div>
              <b>{m.name}</b>
              <span>{d.roles[i]}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
