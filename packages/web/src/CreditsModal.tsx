import { FiCoffee, FiExternalLink, FiFileText, FiHeart, FiX, FiYoutube } from "react-icons/fi";
import { usePromoConfig } from "./promoConfig";
import { useI18n } from "./i18n";
import { Overlay, btnSponsor, card } from "./ui";

/**
 * 感謝名單彈窗:開發人員/核心團隊 + 捐贈名單。名單內容走 promo-config.json
 * (遠端可改,見 promoConfig.ts),不用改版就能增減人員或換連結。
 */
export function CreditsModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const promo = usePromoConfig();
  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[90vh] w-[430px] max-w-full flex-col gap-4 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiHeart className="size-5 text-pal" /> {t("感謝名單")}
          </h2>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-extrabold">{t("開發人員")}</h3>
          {promo.credits.developers.map((d) =>
            d.url ? (
              <a
                key={d.name}
                href={d.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-2 rounded-xl border-2 border-line bg-card-soft px-3 py-2 transition hover:-translate-y-px hover:border-pal"
              >
                <span>
                  <span className="block text-sm font-extrabold">{d.name}</span>
                  <span className="block text-xs text-ink-muted">{t(d.role)}</span>
                </span>
                <FiExternalLink className="size-4 shrink-0 text-ink-muted" />
              </a>
            ) : (
              <div key={d.name} className="rounded-xl border-2 border-line bg-card-soft px-3 py-2">
                <span className="block text-sm font-extrabold">{d.name}</span>
                <span className="block text-xs text-ink-muted">{t(d.role)}</span>
              </div>
            ),
          )}
        </div>

        {(promo.credits.ambassadors ?? []).length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <h3 className="text-sm font-extrabold">{t("推廣大使")}</h3>
            {(promo.credits.ambassadors ?? []).map((a) =>
              a.url ? (
                <a
                  key={a.name}
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between gap-2 rounded-xl border-2 border-line bg-card-soft px-3 py-2 transition hover:-translate-y-px hover:border-pal"
                >
                  <span>
                    <span className="block text-sm font-extrabold">{a.name}</span>
                    <span className="block text-xs text-ink-muted">{t(a.role)}</span>
                  </span>
                  <FiYoutube className="size-4 shrink-0 text-ink-muted" />
                </a>
              ) : (
                <div key={a.name} className="rounded-xl border-2 border-line bg-card-soft px-3 py-2">
                  <span className="block text-sm font-extrabold">{a.name}</span>
                  <span className="block text-xs text-ink-muted">{t(a.role)}</span>
                </div>
              ),
            )}
          </div>
        )}

        <div className="border-t border-line pt-3">
          <h3 className="mb-2 text-sm font-extrabold">{t("捐贈名單")}</h3>
          <p className="mb-2 text-[13px] text-ink-muted">
            {t("感謝每一位支持 palserver GUI 的贊助者,完整名單請見:")}
          </p>
          <a
            className={`${btnSponsor} inline-flex items-center gap-1.5`}
            href={promo.credits.donate}
            target="_blank"
            rel="noreferrer"
          >
            <FiCoffee className="size-4" /> Buy Me a Coffee
          </a>
        </div>

        {/* 授權:原始碼公開,但禁止商業用途 —— 使用者看得到才算「標明」。 */}
        <div className="border-t border-line pt-3">
          <h3 className="mb-1 text-sm font-extrabold">{t("授權")}</h3>
          <p className="text-[13px] text-ink-muted">
            {t("本專案原始碼公開,個人與非商業用途可自由使用、修改與散布,")}
            <b className="text-ink">{t("禁止商業/盈利用途。")}</b>
          </p>
          <a
            className="mt-1.5 inline-flex items-center gap-1.5 text-[13px] font-bold text-ink-muted underline-offset-2 transition hover:text-pal hover:underline"
            href="https://github.com/io-software-ai/palserver-gui/blob/main/LICENSE.md"
            target="_blank"
            rel="noreferrer"
          >
            <FiFileText className="size-4" /> PolyForm Noncommercial 1.0.0
          </a>
        </div>
      </div>
    </Overlay>
  );
}
