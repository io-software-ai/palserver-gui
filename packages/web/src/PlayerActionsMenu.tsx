import { useState } from "react";
import { FiX, FiChevronDown, FiTerminal, FiZap, FiStar } from "react-icons/fi";
import type { AgentClient } from "./api";
import { ConsoleTab } from "./ConsoleTab";
import { CustomPalModal } from "./CustomPalModal";
import { GiveItemsModal } from "./GiveItemsModal";
import { SHOW_SPONSOR_FEATURES } from "./flags";
import { t, useI18n } from "./i18n";
import { Overlay, card, btn, btnGhost } from "./ui";

/** 「操作」選單:每一項對應一條指令(預選 + 預填玩家),或自訂帕魯/帕魯蛋彈窗。
 *  cmd = ConsoleTab 要預選的指令名;customPalMode = 開 CustomPalModal(pal / egg)。
 *  贊助者項目(customPalMode)在未公布前由 SHOW_SPONSOR_FEATURES 濾掉。 */
const PLAYER_ACTIONS: {
  label: string;
  cmd?: string;
  customPalMode?: "pal" | "egg";
  bulkItems?: boolean;
}[] = [
  { label: "給予道具", cmd: "give" },
  { label: "給予帕魯", cmd: "givepal" },
  { label: "給予帕魯蛋", cmd: "giveegg" },
  ...(SHOW_SPONSOR_FEATURES
    ? ([
        { label: "批量給予道具(贊助者)", bulkItems: true },
        { label: "給予自訂帕魯(贊助者)", customPalMode: "pal" },
        { label: "給予自訂帕魯蛋(贊助者)", customPalMode: "egg" },
      ] as const)
    : []),
  { label: "給予經驗值", cmd: "give_exp" },
  { label: "給予科技點數", cmd: "givetechpoints" },
  { label: "給予古代科技點數", cmd: "givebosstechpoints" },
];

/**
 * 玩家操作按鈕(藍色「操作」下拉),放在玩家列表每一列。點選項目跳對應的指令彈窗
 * 或自訂帕魯彈窗,都預填這位玩家(userId)。贊助者限定項目用中空星星標示。
 */
export function PlayerActionsMenu({
  client,
  instanceId,
  userId,
  displayLabel,
}: {
  client: AgentClient;
  instanceId: string;
  userId: string;
  displayLabel: string;
}) {
  useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionCmd, setActionCmd] = useState<string | null>(null);
  const [customPalMode, setCustomPalMode] = useState<"pal" | "egg" | null>(null);
  const [showGiveItems, setShowGiveItems] = useState(false);

  return (
    <>
      <div className="relative">
        <button
          className={`${btn} btn-sm inline-flex items-center gap-1.5`}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <FiZap className="size-3.5" /> {t("操作")} <FiChevronDown className="size-3.5" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl border-2 border-line bg-card shadow-(--shadow-cute)">
              {PLAYER_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-bold transition hover:bg-card-soft"
                  onClick={() => {
                    setMenuOpen(false);
                    if (a.bulkItems) setShowGiveItems(true);
                    else if (a.customPalMode) setCustomPalMode(a.customPalMode);
                    else if (a.cmd) setActionCmd(a.cmd);
                  }}
                >
                  {a.customPalMode || a.bulkItems ? (
                    <FiStar className="size-4 text-pal" />
                  ) : (
                    <FiTerminal className="size-4 text-ink-muted" />
                  )}
                  {t(a.label)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 指令彈窗:預選指令 + 預填這位玩家的 userid,沿用指令台的表單與執行流程。 */}
      {actionCmd && (
        <Overlay onClose={() => setActionCmd(null)}>
          <div
            className={`${card} flex h-[82vh] w-240 max-w-full flex-col gap-3 overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between">
              <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
                <FiTerminal className="size-5 text-pal" /> {t("指令台")} · {displayLabel}
              </h2>
              <button className={btnGhost} onClick={() => setActionCmd(null)} aria-label={t("關閉")}>
                <FiX className="size-4" />
              </button>
            </div>
            <ConsoleTab
              client={client}
              instanceId={instanceId}
              initialCommandName={actionCmd}
              initialValues={{ userid: userId }}
            />
          </div>
        </Overlay>
      )}

      {/* 自訂帕魯 / 帕魯蛋(贊助者):CustomPalModal 自帶授權閘門,預填目標玩家。 */}
      {customPalMode && (
        <CustomPalModal
          client={client}
          instanceId={instanceId}
          mode={customPalMode}
          initialUserId={userId}
          onClose={() => setCustomPalMode(null)}
        />
      )}
      {showGiveItems && (
        <GiveItemsModal
          client={client}
          instanceId={instanceId}
          initialUserId={userId}
          onClose={() => setShowGiveItems(false)}
        />
      )}
    </>
  );
}
