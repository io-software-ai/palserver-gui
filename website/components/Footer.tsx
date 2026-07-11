import type { Dictionary } from '@/i18n/dictionaries';

export default function Footer({ d }: { d: Dictionary['footer'] }) {
  // madeMid 以 "· " 收尾;把分隔點與 "io software" 綁成同一個 nowrap 單位,
  // 視窗變窄時整組一起換行,品牌永遠與「·」同一行、不會被拆開。
  const mid = d.madeMid.replace(/\s*·\s*$/, '');
  return (
    <footer>
      <div className="wrap">
        <a className="flogo" href="https://iosoftware.ai" aria-label="io software">
          <img
            src="/assets/iosoftware-logo-transparent.svg"
            alt="io software"
            width={362}
            height={70}
            loading="lazy"
            draggable={false}
          />
        </a>
        <p className="credit">
          {d.madePre}
          <a
            className="pal"
            style={{ fontWeight: 700, whiteSpace: 'nowrap' }}
            href="https://github.com/Dalufishe"
          >
            Eason Lu (Dalufish)
          </a>
          {mid}{' '}
          <span style={{ whiteSpace: 'nowrap' }}>
            ·{' '}
            <a className="pal" style={{ fontWeight: 700 }} href="https://iosoftware.ai">
              io software
            </a>
          </span>
        </p>
        <span>{d.license}</span>
      </div>
    </footer>
  );
}
