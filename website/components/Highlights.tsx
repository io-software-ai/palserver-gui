import { MapIcon, PaletteIcon, SponsorIcon } from './icons';
import type { Dictionary } from '@/i18n/dictionaries';

/** 三個亮點對應的圖示,順序需與 dictionaries 的 highlights.items 一致。 */
const ICONS = [MapIcon, PaletteIcon, SponsorIcon];

/** v2.0.1 三大新功能亮點:世界地圖、主題系統、贊助者先行版。純文字卡片, 不依賴截圖。 */
export default function Highlights({ d }: { d: Dictionary['highlights'] }) {
  return (
    <section>
      <div className="wrap">
        <div className="col reveal">
          <p className="eyebrow">{d.eyebrow}</p>
          <h2>{d.h2}</h2>
        </div>
        <div className="split3">
          {d.items.map((item, i) => {
            const Icon = ICONS[i];
            return (
              <div className="aud reveal" key={item.tag}>
                <p className="tag">{item.tag}</p>
                <h3>
                  <Icon /> {item.title}
                </h3>
                <p className="hl-body">{item.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
