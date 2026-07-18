'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';

type Release = {
  tag_name: string;
  published_at: string;
  body: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
};

const API = 'https://api.github.com/repos/io-software-ai/palserver-gui/releases?per_page=20';
const RELEASES_URL = 'https://github.com/io-software-ai/palserver-gui/releases';
/** release notes 的四語 <details> 區塊以國旗標記語言。 */
const FLAG: Record<Locale, string> = { zh: '🇹🇼', 'zh-CN': '🇨🇳', en: '🇬🇧', ja: '🇯🇵' };
const DATE_LOCALE: Record<Locale, string> = { zh: 'zh-TW', 'zh-CN': 'zh-CN', en: 'en', ja: 'ja' };

/** 從 release body 取出對應語言的 <details> 區塊;舊格式(無四語區塊)就整份輸出。 */
function sectionFor(body: string, lang: Locale): string {
  const blocks = [...body.matchAll(/<details>\s*<summary><b>([^<]+)<\/b><\/summary>\s*([\s\S]*?)<\/details>/g)];
  const hit = blocks.find((b) => b[1].includes(FLAG[lang]));
  if (hit) return hit[2].trim();
  return body.replace(/<\/?details>|<summary>[\s\S]*?<\/summary>/g, '').trim();
}

/** 行內 markdown:**粗體**、`程式碼`、[文字](連結)。release notes 只用得到這些。 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={i++}>{tok.slice(1, -1)}</code>);
    else {
      const mm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/)!;
      out.push(
        <a key={i++} href={mm[2]} target="_blank" rel="noreferrer">
          {mm[1]}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 區塊級 markdown:###/## 標題、- 清單、> 引用、段落。其餘 HTML 標籤一律剝掉。 */
function renderMd(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  let ul: ReactNode[] = [];
  let k = 0;
  const flush = () => {
    if (ul.length) {
      out.push(<ul key={k++}>{ul}</ul>);
      ul = [];
    }
  };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/<[^>]+>/g, '').trimEnd();
    if (/^\s*[-*] /.test(line)) {
      ul.push(<li key={k++}>{inline(line.replace(/^\s*[-*] /, ''))}</li>);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    if (line.startsWith('### ')) out.push(<h3 key={k++}>{inline(line.slice(4))}</h3>);
    else if (line.startsWith('## ')) out.push(<h3 key={k++}>{inline(line.slice(3))}</h3>);
    else if (line.startsWith('> ')) out.push(<p key={k++} className="quote">{inline(line.slice(2))}</p>);
    else out.push(<p key={k++}>{inline(line)}</p>);
  }
  flush();
  return out;
}

/** 更新日誌清單:client 端直接抓 GitHub Releases(靜態匯出沒有伺服器可代抓)。 */
export default function ChangelogList({ lang, d }: { lang: Locale; d: Dictionary['changelog'] }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch(API)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Release[]>;
      })
      .then((list) => setReleases(list.filter((r) => !r.draft && !r.prerelease)))
      .catch(() => setFailed(true));
  }, []);

  if (failed)
    return (
      <p className="chlog-note">
        {d.error}{' '}
        <a href={RELEASES_URL} target="_blank" rel="noreferrer">
          GitHub Releases
        </a>
      </p>
    );
  if (!releases) return <p className="chlog-note">{d.loading}</p>;

  return (
    <div className="chlog">
      {releases.map((rel, i) => (
        <article className="rel" key={rel.tag_name}>
          <h2>
            {rel.tag_name}
            {i === 0 && <span className="tag-latest">{d.latest}</span>}
            <span className="date">
              {new Date(rel.published_at).toLocaleDateString(DATE_LOCALE[lang], {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </span>
          </h2>
          <div className="md">{renderMd(sectionFor(rel.body, lang))}</div>
          <a className="ghlink" href={rel.html_url} target="_blank" rel="noreferrer">
            {d.viewOnGitHub}
          </a>
        </article>
      ))}
    </div>
  );
}
