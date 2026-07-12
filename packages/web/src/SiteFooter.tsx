import { useEffect, useMemo, useRef, useState } from "react";
import { FiArrowUpCircle } from "react-icons/fi";
import type { AgentUpdateStatus } from "@palserver/shared";
import { AgentClient, type Connection } from "./api";
import { PrivacyModal } from "./PrivacyModal";
import { t, useI18n } from "./i18n";

/** 點左下角「有新版本」小提醒時發出;由 App 的 Shell 接住並打開設定視窗。 */
export const OPEN_SETTINGS_EVENT = "palserver:open-settings";

/**
 * 網站左下角的署名與版本號。低調固定在角落,不干擾操作
 * (右下角是吉祥物,兩者分處左右)。版本字串在 build 時由 vite 注入。
 *
 * 視窗縮小到會蓋住內容時就自動隱藏 —— 用實際的矩形交疊判斷(見 useClearOfContent),
 * 而不是猜一個斷點。
 */
export function SiteFooter({ conn }: { conn: Connection | null }) {
  useI18n();
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [update, setUpdate] = useState<AgentUpdateStatus | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const clear = useClearOfContent(ref);

  // 連線後抓一次 GUI 更新狀態:版本號直接顯示 agent 回報的當前版本(自我更新後會
  // 跟著變),有新版時在角落給個小提醒。updateStatus() 走 agent 快取,不會每次打 GitHub。
  const client = useMemo(() => (conn ? new AgentClient(conn, () => {}) : null), [conn]);
  useEffect(() => {
    if (!client) {
      setUpdate(null);
      return;
    }
    let alive = true;
    client
      .updateStatus()
      .then((s) => alive && setUpdate(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client]);

  const version = update?.currentVersion ?? __APP_VERSION__;

  // 署名句用 {who} 佔位,把三位創作者(各自帶連結)插進翻譯模板裡,語序才能隨語言正確。
  const [byBefore, byAfter = ""] = t("由 {who} 用愛製作").split("{who}");
  const authorLink =
    "pointer-events-auto font-bold underline-offset-2 transition hover:text-pal hover:underline";

  return (
    <>
      <div
        ref={ref}
        // 隱藏時用 invisible(保留版面盒)而非 display:none,否則量不到自己的
        // 矩形,永遠不知道何時該再現身。
        className={`pointer-events-none fixed bottom-2 left-3 z-10 select-none text-[11px] leading-tight text-ink-muted/70 transition-opacity ${
          clear ? "opacity-100" : "invisible opacity-0"
        }`}
      >
        <div>
          {byBefore}
          <a className={authorLink} href="https://instagram.com/easonlu0303" target="_blank" rel="noreferrer">
            Dalufish
          </a>
          ,{" "}
          <a className={authorLink} href="https://iosoftware.ai" target="_blank" rel="noreferrer">
            io Software
          </a>
          &{" "}
          <a className={authorLink} href="https://toc.icu" target="_blank" rel="noreferrer">
            TOC
          </a>
          <span className="opacity-70"> (toc.icu)</span>
          {byAfter}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="font-mono opacity-80">{version}</span>
          {update?.updateAvailable && (
            <button
              className="pointer-events-auto inline-flex items-center gap-1 rounded-full bg-pal/15 px-1.5 py-0.5 font-bold text-pal transition hover:bg-pal/25"
              onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT))}
              title={t("有新版本")}
            >
              <FiArrowUpCircle className="size-3" /> {t("有新版本")}
              {update.latestVersion && (
                <span className="font-mono font-normal opacity-90">{update.latestVersion}</span>
              )}
            </button>
          )}
          <button
            className="pointer-events-auto underline-offset-2 transition hover:text-pal hover:underline"
            onClick={() => setShowPrivacy(true)}
          >
            {t("隱私權政策")}
          </button>
        </div>
      </div>
      {/* modal 放在 footer 容器外,避免吃到 11px 字級與 select-none 的繼承。 */}
      {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
    </>
  );
}

/**
 * 這個固定定位的角落元素目前是否「沒有蓋到內容」。
 *
 * 拿自己的矩形跟內容區([data-content-root])的矩形比對,內容區的 padding 視為
 * 可壓的留白(蓋在留白上不算蓋到東西)。視窗縮放、捲動、內容長高都會重新量。
 * 找不到內容區時(例如連線畫面)一律顯示。
 */
function useClearOfContent(ref: React.RefObject<HTMLElement | null>): boolean {
  const [clear, setClear] = useState(true);

  useEffect(() => {
    let frame = 0;
    let watched: Element | null = null;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resizes = new ResizeObserver(schedule);

    const measure = () => {
      const el = ref.current;
      const content = document.querySelector<HTMLElement>("[data-content-root]");
      // 內容區會隨著連線/斷線整個換掉,追著現在這一個量。
      if (content !== watched) {
        if (watched) resizes.unobserve(watched);
        if (content) resizes.observe(content);
        watched = content;
      }
      if (!el || !content) return setClear(true);

      const me = el.getBoundingClientRect();
      const box = content.getBoundingClientRect();
      const pad = getComputedStyle(content);
      const left = box.left + (parseFloat(pad.paddingLeft) || 0);
      const right = box.right - (parseFloat(pad.paddingRight) || 0);
      const top = box.top + (parseFloat(pad.paddingTop) || 0);
      const bottom = box.bottom - (parseFloat(pad.paddingBottom) || 0);

      setClear(!(me.right > left && me.left < right && me.bottom > top && me.top < bottom));
    };

    measure();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    // 內容區是連線後才掛上的,DOM 一變就重新找它。
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      resizes.disconnect();
      mutations.disconnect();
    };
  }, [ref]);

  return clear;
}
