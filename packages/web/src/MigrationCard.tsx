import { useState } from "react";
import { FiX, FiUploadCloud, FiArrowRight } from "react-icons/fi";
import { Markdown } from "./Markdown";
import { t, useI18n } from "./i18n";
import { card, btn as btnPrimary, btnGhost } from "./ui";

/**
 * 總覽頁的「存檔遷移」卡片:精簡三行重點 + 一顆按鈕開啟完整教學彈窗。
 * 彈窗沿用跟公告一樣的 Markdown 介面。詳細內容精簡自 docs/MIGRATION.md。
 */
export function MigrationCard({ onDismiss }: { onDismiss?: () => void }) {
  useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className={`${card} flex flex-col gap-3`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="inline-flex items-center gap-2 text-sm font-extrabold text-ink-muted">
          <FiUploadCloud className="size-4 text-pal" /> {t("存檔遷移")}
        </h3>
        {onDismiss && (
          <button
            className="-mr-1 -mt-1 rounded-lg p-1 text-ink-muted transition hover:bg-card-soft hover:text-ink"
            onClick={onDismiss}
            title={t("隱藏此卡片(可在設定恢復)")}
            aria-label={t("隱藏此卡片(可在設定恢復)")}
          >
            <FiX className="size-4" />
          </button>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-ink-muted">
        {t("已經有一個 Palworld 世界想搬進來?不管是別台專用伺服器、v1 舊版,還是本機四人邀請碼存檔,都能接管。")}
        <b className="text-ink">{t("最關鍵的一步")}</b>
        {t("是把「啟用世界」指到你的存檔 —— 在")}
        <b className="text-ink">{t("存檔備份")}</b>
        {t("分頁按一下就好。")}
      </p>
      <ul className="flex flex-col gap-1.5 text-[13px] text-ink-muted">
        <li className="flex gap-2"><FiArrowRight className="mt-0.5 size-3.5 shrink-0 text-pal" /> {t("遷移前務必停止伺服器,來源端遊戲也要關閉")}</li>
        <li className="flex gap-2"><FiArrowRight className="mt-0.5 size-3.5 shrink-0 text-pal" /> {t("新實例先啟動一次再停止,讓存檔資料夾生成")}</li>
        <li className="flex gap-2"><FiArrowRight className="mt-0.5 size-3.5 shrink-0 text-pal" /> {t("本機邀請碼存檔需額外修正玩家角色")}</li>
      </ul>
      <div className="mt-1">
        <button className={btnPrimary} onClick={() => setOpen(true)}>
          {t("查看完整教學")}
        </button>
      </div>
      {open && <MigrationModal onClose={() => setOpen(false)} />}
    </div>
  );
}

function MigrationModal({ onClose }: { onClose: () => void }) {
  useI18n();
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[rgb(35_32_48/0.55)] p-6 backdrop-blur-[3px]"
      onClick={onClose}
    >
      <div
        className={`${card} max-h-[90vh] w-[560px] max-w-full overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiUploadCloud className="size-5 text-pal" /> {t("存檔遷移教學")}
          </h2>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>
        <div className="mt-3 max-h-[68vh] overflow-y-auto pr-1 text-[13px] leading-relaxed text-ink">
          <Markdown source={t(GUIDE)} />
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnGhost} onClick={onClose}>
            {t("關閉")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 詳細教學,精簡自 docs/MIGRATION.md,以彈窗閱讀為主。 */
const GUIDE = `
> **開始之前**:所有遷移都要在**伺服器停止**下進行,來源端的遊戲/伺服器也要完全關閉。Palworld 執行時會持續寫入存檔,複製到一半的檔案是壞的。

## 最重要的觀念

伺服器不會自動載入「唯一那個」世界資料夾,而是讀 \`GameUserSettings.ini\` 裡的 \`DedicatedServerName=\` 去找對應 GUID 的資料夾。遷移失敗九成是這裡沒對上,伺服器找不到就默默開一個全新世界。

好消息:在 GUI 的**存檔備份**分頁,每個世界的 GUID 和「啟用中」狀態都列得清清楚楚,按「設為啟用世界」就會幫你改好這一行,完全不用手動編輯。

## 情境 A:從別台專用伺服器搬過來

最單純,格式完全相同。

1. **來源端**停止舊伺服器,到 \`Pal/Saved/SaveGames/0/\` 找到你的世界資料夾(一串英數字 GUID),整包壓成 zip。
2. **目標端**在 GUI 建立實例後,**先啟動一次再停止** —— Palworld 只有第一次啟動才會生成存檔與設定檔。
3. GUI → **模組**分頁 → 「瀏覽全部」→ 進到 \`Pal/Saved/SaveGames/0/\`,把 GUID 資料夾裡的 .sav 上傳進去。
4. GUI → **存檔備份**分頁 → 找到剛上傳的世界 → 按「**設為啟用世界**」。
5. 啟動伺服器,玩家用原本的角色進來即可。

> **不要直接複製舊的 \`GameUserSettings.ini\`**。它夾帶舊主機的 PublicIP、RCON 設定,會讓伺服器列表顯示錯誤或遠端管理失效。只需要改 \`DedicatedServerName\`,而這件事 GUI 幫你做。

## 情境 B:從 v1 palserver-GUI 搬過來

v1 底下的 \`Pal/Saved/\` 結構和情境 A 完全一樣,照情境 A 操作即可。

如果 v1 就在同一台機器,更省事的做法是**直接收編**:建立實例時把「既有伺服器路徑」填 v1 那個伺服器目錄(含 \`PalServer.exe\` 的那一層),世界、模組、設定全部原地接管,不用搬檔。

## 情境 C:從本機多人(四人邀請碼)搬過來

這是唯一會踩到**角色重置**的情境:本機存檔的 PlayerUid 編碼方式和專用伺服器不同,直接搬玩家進來會被要求重建角色(帕魯和建築還在,角色不見)。

1. 找到本機存檔:\`%LOCALAPPDATA%\\Pal\\Saved\\SaveGames\\<你的 SteamID>\\<世界 GUID>\\\`
2. 照情境 A 上傳到伺服器的 \`SaveGames/0/\` 下。
3. 用社群工具 [palworld-host-save-fix](https://github.com/xNul/palworld-host-save-fix) 把主機玩家的 .sav 轉成專用伺服器格式(需要舊 host 存檔檔名,以及每位玩家先進伺服器一次產生的新 PlayerUid)。
4. 回 GUI「設為啟用世界」→ 啟動。

> 沒有工具能百分百保證主機角色轉移成功。**動手前先在 GUI 按「立即備份」**,出事可以一鍵還原。

## 遷移後檢查清單

- **存檔備份**分頁裡,你的世界標示為「啟用中」
- 世界大小合理(空世界通常不到 1 MB;玩過的世界幾十 MB 起跳)
- 啟動後日誌沒有 \`Save data is corrupted\`
- 進遊戲確認建築、帕魯、等級都在

## 常見問題

**進去變全新世界,舊東西都不見** — \`DedicatedServerName\` 沒指到你的 GUID,到存檔備份分頁按「設為啟用世界」。

**世界在但要我重建角色** — 情境 C 的 PlayerUid 問題,見上方第 3 步;若是伺服器互搬,檢查 \`Players/\` 資料夾有沒有漏複製。

**啟動就 \`Save data is corrupted\`** — 存檔複製時來源端沒關乾淨,或傳輸截斷。用備份還原,重新複製一次。

**跨平台(Windows ↔ Linux)** — 可以,\`.sav\` 格式相同;設定檔分別在 \`Config/WindowsServer/\` 與 \`Config/LinuxServer/\`,GUI 會依平台自動處理。
`;
