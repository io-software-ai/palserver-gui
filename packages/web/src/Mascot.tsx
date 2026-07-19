import { useState } from "react";
import { FiX, FiExternalLink, FiHeart, FiInstagram } from "react-icons/fi";
import { SiDiscord } from "react-icons/si";
import { usePromoConfig } from "./promoConfig";
import { useDiscordWidget } from "./discordWidget";
import { useHiddenCards } from "./tabPrefs";
import { t, useI18n } from "./i18n";
import { card, btnSponsor, btnGhost } from "./ui";

/**
 * A big curled-up sleeping orange cat tucked into the dashboard's bottom
 * corner — an illustration of the author's cat (background removed, so it
 * sits on both themes). It blends into the background (low opacity) but
 * gently breathes/wiggles to invite a click — until it's been clicked once,
 * after which the attention state is retired (localStorage). Clicking opens
 * a light-hearted sponsor/company promo.
 */
const SEEN_KEY = "palserver.mascotSeen";

export function Mascot() {
  useI18n();
  const [seen, setSeen] = useState(() => localStorage.getItem(SEEN_KEY) === "1");
  const [open, setOpen] = useState(false);
  // 設定 → 「右下角貓貓」可整隻關掉(全域偏好,與卡片隱藏共用同一份清單)。
  const [hiddenCards] = useHiddenCards();
  if (hiddenCards.includes("mascot")) return null;

  const onClick = () => {
    if (!seen) {
      setSeen(true);
      localStorage.setItem(SEEN_KEY, "1");
    }
    setOpen(true);
  };

  return (
    <>
      <button
        onClick={onClick}
        aria-label="io software"
        className={`fixed right-2 bottom-0 z-0 origin-bottom transition-opacity ${
          seen ? "opacity-15 hover:opacity-40" : "animate-[breathe_3s_ease-in-out_infinite] opacity-45 hover:opacity-70"
        }`}
        style={{ width: "min(300px, 34vw)" }}
      >
        <img src="/mascot.webp" alt="" draggable={false} className="h-auto w-full" />
        {!seen && (
          <span className="absolute -top-2 left-1/2 -translate-x-1/2 animate-bounce rounded-full bg-pal px-3 py-1 text-xs font-extrabold whitespace-nowrap text-white shadow">
            {t("摸摸我~")}
          </span>
        )}
      </button>

      {/* keyframes for the idle breathing (component-scoped) */}
      <style>{`@keyframes breathe{0%,100%{transform:scale(1) rotate(-1deg)}50%{transform:scale(1.03) rotate(1deg)}}`}</style>

      {open && <SponsorModal onClose={() => setOpen(false)} />}
    </>
  );
}

function SponsorModal({ onClose }: { onClose: () => void }) {
  useI18n();
  const { company } = usePromoConfig();
  const discordOnline = useDiscordWidget(company.discordGuildId);
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-[rgb(35_32_48/0.55)] p-6 backdrop-blur-[3px]"
      onClick={onClose}
    >
      <div
        className={`${card} max-h-[90vh] w-[420px] max-w-full overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiHeart className="size-5 text-pal" /> {t("喜歡這隻貓貓嗎?")}
          </h2>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>
        <p className="mt-2 text-[13px] text-ink-muted">
          {t("嗨嗨~ 我是")} <b>Dalufish</b>{t(", palserver GUI 就是我做的!這隻工具是免費的, 如果它幫上你的忙, 睡搞搞的貓貓想討一點罐罐 —— 追蹤我們、或小額贊助都是超大的鼓勵, 讓我們能繼續把它做得更好。")}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <a className={`${btnSponsor} inline-flex items-center justify-center gap-1.5`} href={company.sponsor} target="_blank" rel="noreferrer">
            <FiHeart className="size-4" /> {t("贊助我們")}
          </a>
          <a className={`${btnGhost} inline-flex items-center justify-center gap-1.5`} href={company.instagram} target="_blank" rel="noreferrer">
            <FiInstagram className="size-4" /> Instagram
          </a>
          <a className={`${btnGhost} inline-flex items-center justify-center gap-1.5`} href={company.website} target="_blank" rel="noreferrer">
            <FiExternalLink className="size-4" /> {t("官方網站")}
          </a>
          <a className={`${btnGhost} inline-flex items-center justify-center gap-1.5`} href={company.discord} target="_blank" rel="noreferrer">
            <SiDiscord className="size-4" /> Discord
            {discordOnline != null && (
              <span className="text-[11px] font-bold text-grass">{t("線上 {n} 人", { n: discordOnline })}</span>
            )}
          </a>
        </div>
        <p className="mt-3 text-center text-xs text-ink-muted">{t("感謝你讓帕魯世界更好玩 🐾")}</p>
      </div>
    </div>
  );
}
