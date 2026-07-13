import { useState } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import type { FileHealth } from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { Overlay, btn, btnGhost, card, errorCls } from "./ui";

/**
 * Shown when the on-disk PalWorldSettings.ini / Engine.ini is corrupted.
 * Regeneration backs up the broken file and writes a fresh valid one — the
 * world config from the agent's stored settings, the engine config minimal.
 * Requires the server to be stopped (the agent guards this).
 */
export function ConfigCorruptModal({
  client,
  instanceId,
  file,
  health,
  running,
  onResolved,
}: {
  client: AgentClient;
  instanceId: string;
  file: "world" | "engine";
  health: FileHealth;
  running: boolean;
  onResolved: () => void;
}) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = file === "world" ? t("世界設定檔(PalWorldSettings.ini)") : t("效能設定檔(Engine.ini)");

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await client.regenerateConfig(instanceId, file);
      onResolved();
      alert(
        res.backedUp
          ? t("已生成新的設定檔。原損壞檔案已備份為 {path}.corrupt-*.bak", { path: res.path })
          : t("已生成新的設定檔。"),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={() => {}}>
      <div
        className={`${card} flex max-h-[90vh] w-[460px] max-w-full flex-col gap-3 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="inline-flex items-center gap-2 text-lg font-extrabold text-berry">
          <FiAlertTriangle className="size-5" /> {t("設定檔已損壞")}
        </h2>
        <p className="text-[13px] text-ink-muted">
          {label}{t("無法正確解析,伺服器可能會忽略設定或開出一個全新的世界。")}
        </p>
        {health.reason && (
          <p className="rounded-xl bg-berry/10 px-3 py-2 text-[13px] font-bold text-berry">
            {t("問題:")}{health.reason}
          </p>
        )}
        <p className="text-[13px] text-ink-muted">
          {t("可以生成一份新的設定檔")}
          {file === "world" ? t("(依 GUI 目前儲存的世界設定)") : ""}{t("。原本的損壞檔案會先備份起來,不會直接刪除。")}
        </p>
        {error && <p className={errorCls}>{error}</p>}
        {running && (
          <p className="rounded-xl bg-sun/10 px-3 py-2 text-[13px] font-bold text-sun">
            {t("請先停止伺服器再重新生成。")}
          </p>
        )}
        <div className="flex gap-2">
          <button className={btn} onClick={regenerate} disabled={busy || running}>
            {busy ? t("生成中…") : t("生成新的設定檔")}
          </button>
          <button className={btnGhost} onClick={onResolved} disabled={busy}>
            {t("稍後再說")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
