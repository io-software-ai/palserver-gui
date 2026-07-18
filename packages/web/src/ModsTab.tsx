import { useCallback, useEffect, useState } from "react";
import { FiPackage, FiFolder, FiTrash2, FiAlertTriangle } from "react-icons/fi";
import type { ModComponent, ModsStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { FileBrowserDialog } from "./FileManager";
import { ModInstallCard } from "./ModInstallCard";
import { t, useI18n } from "./i18n";
import { EmptyState, btnGhost, card, errorCls, DismissibleWarning } from "./ui";


export function ModsTab({
  client,
  instanceId,
  running,
  onModsChanged,
}: {
  client: AgentClient;
  instanceId: string;
  running: boolean;
  /** 安裝/移除模組後通知外層(讓 PalDefender 分頁的 gating 同步)。 */
  onModsChanged?: () => void;
}) {
  useI18n();
  const [mods, setMods] = useState<ModsStatus | null>(null);
  // 各元件最新穩定版(「有新版」徽章);null=查詢失敗或尚未載入
  const [latest, setLatest] = useState<{ ue4ss: string | null; paldefender: string | null } | null>(null);
  const [pakMods, setPakMods] = useState<{ name: string; size: number; enabled: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [modStatus, pakList] = await Promise.allSettled([
        client.mods(instanceId),
        client.listPakMods(instanceId),
      ]);
      if (modStatus.status === "fulfilled") setMods(modStatus.value);
      if (pakList.status === "fulfilled") setPakMods(pakList.value.mods);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    client.modsLatest().then(setLatest).catch(() => {});
  }, [client]);

  const install = async (component: ModComponent, channel: "stable" | "beta" = "stable") => {
    if (channel === "beta" && !confirm(t("測試版(Beta)可能不穩定,但含較新的功能(例如玩家細節 API)。\n\n確定要安裝最新測試版嗎?"))) {
      return;
    }
    setBusy(component);
    setError(null);
    try {
      await client.installMod(instanceId, component, channel);
      await refresh();
      onModsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const setComponentEnabled = async (component: ModComponent, enabled: boolean) => {
    setBusy(component);
    setError(null);
    try {
      setMods(await client.setModEnabled(instanceId, component, enabled));
      onModsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (name: string, enabled: boolean) => {
    try {
      setMods(await client.toggleLuaMod(instanceId, name, enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!mods) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;

  if (!mods.supported) {
    return (
      <div className="flex flex-col gap-4">
        {error && <p className={errorCls}>{error}</p>}
        <EmptyState icon={<FiPackage />}>{mods.reason}</EmptyState>
        {(mods.serverInstalled ?? true) && (
        <PakModCard
          pakMods={pakMods}
          busy={!!busy}
          onToggle={async (name, enabled) => {
            try { setBusy(name); await client.togglePakMod(instanceId, name, enabled); await refresh(); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(null); }
          }}
          onRemove={async (name) => {
            if (!confirm(t("確定要移除 {name}？", { name }))) return;
            try { setBusy(name); await client.removePakMod(instanceId, name); await refresh(); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(null); }
          }}
        />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}
      <DismissibleWarning id="warn-mods-compat">
        <span className="inline-flex items-start gap-2">
          <FiAlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {t("每次")} <b>{t("Palworld 改版")}</b>{t("後,PalDefender / UE4SS 常會")}<b>{t("暫時無法使用")}</b>{t(",要等模組作者釋出相容版本(通常改版後幾天內)。若改版後伺服器啟動異常或閃退,先回這裡")}<b>{t("更新到最新版")}</b>{t(",或先按")}<b>{t("停用")}</b>{t("(不刪檔,Lua 模組與設定都保留)再開服。")}
          </span>
        </span>
      </DismissibleWarning>
      {running && (
        <p className="rounded-xl bg-sun/10 px-3 py-2 text-[13px] font-bold text-sun">
          {t("伺服器運作中:安裝、更新或移除模組需要先停止伺服器(執行中時模組檔案被鎖定)。")}
        </p>
      )}
      <ModInstallCard
        title={t("UE4SS 模組載入器")}
        desc={t("Lua / Blueprint 模組的執行環境。安裝後即可在下方管理 Lua 模組。")}
        installed={mods.ue4ss.installed}
        version={mods.ue4ss.version}
        running={running}
        busy={busy === "ue4ss"}
        onInstall={() => void install("ue4ss")}
        onInstallBeta={() => void install("ue4ss", "beta")}
        enabled={mods.ue4ss.enabled}
        onToggleEnabled={() => void setComponentEnabled("ue4ss", mods.ue4ss.enabled === false)}
        latestVersion={latest?.ue4ss}
        note={t("安裝或更新後,重啟伺服器才會生效。")}
      />
      <div className={card}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-ink-muted">{t("Lua 模組(UE4SS)")}</h3>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setBrowsing(mods.luaModsDir!)}
            disabled={mods.luaModsDir === null}
            title={mods.luaModsDir ?? t("先安裝 UE4SS")}
          >
            <FiFolder className="size-4" /> {t("開啟 Lua 模組資料夾")}
          </button>
        </div>
        {mods.luaMods.length === 0 ? (
          <EmptyState compact>
            {mods.luaModsDir === null
              ? t("尚無 Lua 模組。先安裝 UE4SS,之後就能在此上傳與管理模組。")
              : t("尚無 Lua 模組。用上方的「開啟 Lua 模組資料夾」上傳模組資料夾。")}
          </EmptyState>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {mods.luaMods.map((m) => (
              <div key={m.name} className="flex items-center justify-between py-2.5">
                <span className="text-sm font-bold">{m.name}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={m.enabled}
                  onClick={() => toggle(m.name, !m.enabled)}
                  className={`relative h-7 w-12 rounded-full transition ${m.enabled ? "bg-grass" : "bg-line"}`}
                >
                  <span
                    className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${m.enabled ? "left-6" : "left-1"}`}
                  />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {browsing !== null && (
        <FileBrowserDialog
          client={client}
          instanceId={instanceId}
          initialPath={browsing}
          onClose={() => {
            setBrowsing(null);
            void refresh();
          }}
        />
      )}

      <PakModCard
        pakMods={pakMods}
        busy={!!busy}
        onBrowse={() => setBrowsing("Pal/Content/Paks")}
        onToggle={async (name, enabled) => {
          try { setBusy(name); await client.togglePakMod(instanceId, name, enabled); await refresh(); }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(null); }
        }}
        onRemove={async (name) => {
          if (!confirm(t("確定要移除 {name}？", { name }))) return;
          try { setBusy(name); await client.removePakMod(instanceId, name); await refresh(); }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(null); }
        }}
      />
    </div>
  );
}

/** Pak mod 管理卡片（跨平台：native/docker/k8s）。 */
function PakModCard({
  pakMods,
  busy,
  onToggle,
  onRemove,
  onBrowse,
}: {
  pakMods: { name: string; size: number; enabled: boolean }[];
  busy: boolean;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
  /** 開啟 Paks 資料夾(檔案管理);未提供就不顯示按鈕。 */
  onBrowse?: () => void;
}) {
  const fmtSize = (n: number) =>
    n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n > 0 ? `${(n / (1 << 10)).toFixed(0)} KB` : "—";

  return (
    <div className={card}>
      <div className="mb-2 flex items-center gap-2">
        <FiPackage className="size-5 text-grass" />
        <h3 className="text-sm font-extrabold">{t("Pak 模組")}</h3>
        <span className="rounded-full bg-grass/10 px-2 py-0.5 text-[11px] font-bold text-grass">
          {t("跨平台")}
        </span>
        {onBrowse && (
          <button
            className={`${btnGhost} ml-auto inline-flex items-center gap-1.5`}
            onClick={onBrowse}
          >
            <FiFolder className="size-4" /> {t("開啟 Paks 資料夾")}
          </button>
        )}
      </div>
      <p className="mb-3 text-[13px] text-ink-muted">
        {t(".pak 檔放入 Pal/Content/Paks/ 後由遊戲引擎自動載入,不需 UE4SS。透過檔案管理上傳 pak 後在此管理。")}
      </p>
      {pakMods.length === 0 ? (
        <EmptyState compact>{t("目前沒有 pak 模組。")}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {pakMods.map((mod) => (
            <li key={mod.name} className="flex items-center justify-between gap-2 rounded-lg bg-cream px-3 py-2 text-[13px]">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${mod.enabled ? "bg-grass/15 text-grass" : "bg-ink/10 text-ink-muted"}`}
                  onClick={() => onToggle(mod.name, !mod.enabled)}
                  disabled={busy}
                >
                  {mod.enabled ? t("啟用") : t("停用")}
                </button>
                <span className="truncate font-mono">{mod.name}</span>
                <span className="shrink-0 text-ink-muted">{fmtSize(mod.size)}</span>
              </div>
              <button
                className="shrink-0 text-error/70 hover:text-error"
                onClick={() => onRemove(mod.name)}
                disabled={busy}
              >
                <FiTrash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

