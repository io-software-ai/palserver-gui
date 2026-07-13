import { useEffect, useState } from "react";
import { FiBell, FiArrowRight } from "react-icons/fi";
import { useAnnouncements, seenIds, markSeen, isActive, type Announcement } from "./announcement";
import { Markdown } from "./Markdown";
import { t, useI18n } from "./i18n";
import { card, btn as btnPrimary } from "./ui";

/**
 * 公告彈窗:把「尚未看過」的公告依檔案順序一則一則顯示,必須逐則點過才能開始
 * (沒有背景關閉、沒有 X)。內容來自 announcement.md,渲染用共用的 Markdown 元件。
 */
export function AnnouncementPopup() {
  useI18n();
  const all = useAnnouncements();
  // 進場時捕捉這次要顯示的佇列(未看過的,依順序),之後不隨資料變動而改變,
  // 避免顯示到一半數量跳動。資料就緒(all 有內容)後才捕捉一次。
  const [queue, setQueue] = useState<Announcement[] | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (queue === null && all.length) {
      const seen = seenIds();
      // 只顯示:尚未看過、且仍啟用/未過期的公告。
      setQueue(all.filter((a) => !seen.has(a.id) && isActive(a)));
    }
  }, [all, queue]);

  if (!queue || index >= queue.length) return null;
  const current = queue[index];
  const isLast = index === queue.length - 1;

  const next = () => {
    markSeen(current.id);
    setIndex((i) => i + 1);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgb(35_32_48/0.55)] p-6 backdrop-blur-[3px]">
      <div className={`${card} max-h-[90vh] w-[460px] max-w-full overflow-y-auto`}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiBell className="size-5 text-pal" /> {t(current.title)}
          </h2>
          {queue.length > 1 && (
            <span className="shrink-0 rounded-full bg-card-soft px-2.5 py-1 text-xs font-bold text-ink-muted">
              {t("第 {i} / {n} 則", { i: index + 1, n: queue.length })}
            </span>
          )}
        </div>
        <div className="mt-3 max-h-[60vh] overflow-y-auto pr-1 text-[13px] leading-relaxed text-ink">
          <Markdown source={current.body} />
        </div>
        <div className="mt-4 flex justify-end">
          <button className={`${btnPrimary} inline-flex items-center gap-1.5`} onClick={next}>
            {isLast ? t("我知道了") : t("下一則")}
            {!isLast && <FiArrowRight className="size-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
