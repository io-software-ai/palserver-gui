import { useCallback, useEffect, useState } from "react";
import { FiCheck, FiDownload, FiPackage, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import type { VersionStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card, errorCls } from "./ui";

/** Installed game version and whether Steam has a newer build. */
export function VersionCard({
  client,
  instanceId,
  running,
  canReinstall,
  onUpdateStarted,
}: {
  client: AgentClient;
  instanceId: string;
  running: boolean;
  /** native 才提供「重灌」(刪除本體重新下載;adopt 目錄由 agent 端擋) */
  canReinstall?: boolean;
  onUpdateStarted: () => void;
}) {
  useI18n();
  const [version, setVersion] = useState<VersionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setVersion(await client.version(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!version) return null;

  const update = async (fresh = false) => {
    const message = fresh
      ? t(
          "重灌會【刪除】遊戲本體檔案後全新下載(數 GB)。\n\n會保留:世界存檔與設定檔(整個 Pal/Saved,含 PalWorldSettings.ini / Engine.ini),並在開始前自動備份啟用中的世界。\n會刪除:已安裝的模組(UE4SS / PalDefender / pak),重灌後需重新安裝。\n\n確定要重灌嗎?",
        )
      : t("更新會重新下載伺服器檔案(數 GB),期間伺服器無法啟動。\n\n確定要更新嗎?");
    if (!confirm(message)) return;
    setBusy(true);
    setError(null);
    try {
      await client.updateServer(instanceId, fresh);
      onUpdateStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={card}>
      <h3 className="mb-3 inline-flex items-center gap-2 text-sm font-extrabold text-ink-muted">
        <FiPackage className="size-4 text-pal" /> {t("遊戲版本")}
      </h3>

      {error && <p className={`mb-3 ${errorCls}`}>{error}</p>}

      <dl className="flex flex-col gap-2">
        <Row label={t("伺服器版本")} value={version.gameVersion ?? t("未知(啟動一次伺服器即可取得)")} />
        {version.installedBuild && (
          <Row label={t("已安裝建置")} value={version.installedBuild} mono />
        )}
        {version.latestBuild && <Row label={t("最新建置")} value={version.latestBuild} mono />}
        {version.latestUpdatedAt && (
          <Row label={t("官方更新時間")} value={new Date(version.latestUpdatedAt).toLocaleString()} />
        )}
      </dl>

      <div className="mt-3">
        {version.updateAvailable === true ? (
          <div className="rounded-xl border-2 border-sun/40 bg-sun/10 p-3">
            <p className="text-[13px] font-bold text-sun">
              {t("有新版本可更新。更新前建議先到「存檔備份」建立一份備份。")}
            </p>
          </div>
        ) : version.updateAvailable === false ? (
          <p className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-grass/40 bg-grass/15 px-3 py-1 text-xs font-bold text-grass">
            <FiCheck className="size-3.5" /> {t("已是最新版本")}
          </p>
        ) : (
          <p className="text-[13px] text-ink-muted">
            {version.reason ? t(version.reason) : t("無法判斷是否有新版本(可能連不上 Steam)。")}
          </p>
        )}
      </div>

      {/* 更新按鈕常駐:版本偵測失敗(連不上 Steam 等)的使用者也要能手動更新;
          更新本身內含檔案驗證,已是最新時重跑等於 verify+repair,無害 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className={`${version.updateAvailable === true ? btn : btnGhost} inline-flex items-center gap-1.5`}
          onClick={() => void update()}
          disabled={busy || running}
          title={
            running
              ? t("請先停止伺服器")
              : version.updateAvailable === true
                ? undefined
                : t("重新執行更新(內含檔案完整性驗證);偵測不到版本落差時也可用")
          }
        >
          <FiDownload className="size-4" /> {busy ? t("啟動更新中…") : t("立即更新")}
        </button>
        <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={refresh}>
          <FiRefreshCw className="size-3.5" /> {t("重新檢查")}
        </button>
        {canReinstall && (
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5 text-berry hover:border-berry`}
            onClick={() => void update(true)}
            disabled={busy || running}
            title={
              running
                ? t("請先停止伺服器")
                : t("更新一直失敗時用:刪除遊戲本體後全新下載;存檔與設定檔(Pal/Saved)完整保留")
            }
          >
            <FiTrash2 className="size-3.5" /> {t("重灌伺服器")}
          </button>
        )}
        {version.checkedAt && (
          <span className="text-xs text-ink-muted">
            {t("版本資訊取得於")} {new Date(version.checkedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className={`text-right font-bold break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
