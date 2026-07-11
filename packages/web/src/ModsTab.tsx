import { useCallback, useEffect, useState } from "react";
import { GiShield, GiScrollUnfurled } from "react-icons/gi";
import { FiDownload, FiCheck, FiPackage, FiFolder, FiTrash2, FiAlertTriangle } from "react-icons/fi";
import type { ModComponent, ModsStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { FileBrowserDialog } from "./FileManager";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card, errorCls } from "./ui";

const COMPONENTS: {
  id: ModComponent;
  title: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "paldefender",
    title: "PalDefender 反外掛",
    desc: "伺服器端驗證,防止已知外掛、漏洞與惡意崩潰(前身為 Palguard)。安裝後啟動一次伺服器會自動生成設定檔。",
    icon: <GiShield className="size-8 text-pal" />,
  },
  {
    id: "ue4ss",
    title: "UE4SS 模組載入器",
    desc: "Lua / Blueprint 模組的執行環境。安裝後即可在下方管理 Lua 模組。",
    icon: <GiScrollUnfurled className="size-8 text-pal" />,
  },
];

export function ModsTab({
  client,
  instanceId,
  running,
}: {
  client: AgentClient;
  instanceId: string;
  running: boolean;
}) {
  useI18n();
  const [mods, setMods] = useState<ModsStatus | null>(null);
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

  const install = async (component: ModComponent, channel: "stable" | "beta" = "stable") => {
    if (channel === "beta" && !confirm(t("測試版(Beta)可能不穩定,但含較新的功能(例如玩家細節 API)。\n\n確定要安裝最新測試版嗎?"))) {
      return;
    }
    setBusy(component);
    setError(null);
    try {
      await client.installMod(instanceId, component, channel);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (component: ModComponent) => {
    const label = component === "paldefender" ? "PalDefender" : "UE4SS";
    if (!confirm(t("確定要移除 {label} 嗎?\n\n會刪除它安裝的檔案({extra}也會一併移除)。此動作無法復原,重啟後生效。", { label, extra: label === "UE4SS" ? t("含 Lua 模組") : t("含設定檔") }))) {
      return;
    }
    setBusy(component);
    setError(null);
    try {
      await client.uninstallMod(instanceId, component);
      await refresh();
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
        <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-8 text-center text-ink-muted">
          <FiPackage className="mx-auto mb-2 size-11" />
          {mods.reason}
        </div>
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
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}
      <p className="inline-flex items-start gap-2 rounded-xl border-2 border-sun/40 bg-sun/10 px-3 py-2 text-[13px] text-sun">
        <FiAlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>
          {t("每次")} <b>{t("Palworld 改版")}</b>{t("後,PalDefender / UE4SS 常會")}<b>{t("暫時無法使用")}</b>{t(",要等模組作者釋出相容版本(通常改版後幾天內)。若改版後伺服器啟動異常或閃退,先回這裡")}<b>{t("更新到最新版")}</b>{t(",或先")}<b>{t("移除")}</b>{t("模組再開服。")}
        </span>
      </p>
      {running && (
        <p className="rounded-xl bg-sun/10 px-3 py-2 text-[13px] font-bold text-sun">
          {t("伺服器運作中:安裝、更新或移除模組需要先停止伺服器(執行中時模組檔案被鎖定)。")}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {COMPONENTS.map((c) => {
          const state = mods[c.id];
          return (
            <div key={c.id} className={card}>
              <div className="flex items-start gap-3">
                {c.icon}
                <div className="flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-extrabold">{t(c.title)}</h3>
                    {state.installed && (
                      <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-grass/40 bg-grass/15 px-3 py-1 text-xs font-bold text-grass">
                        <FiCheck className="size-3.5" />
                        {t("已安裝")}{state.version ? ` ${state.version}` : ""}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[13px] text-ink-muted">{t(c.desc)}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className={`${btn} inline-flex items-center gap-1.5`}
                      onClick={() => install(c.id)}
                      disabled={busy !== null || running}
                      title={running ? t("請先停止伺服器") : undefined}
                    >
                      <FiDownload className="size-4" />
                      {busy === c.id ? t("安裝中…") : state.installed ? t("更新到最新版") : t("安裝穩定版")}
                    </button>
                    <button
                      className={`${btnGhost} inline-flex items-center gap-1.5`}
                      onClick={() => install(c.id, "beta")}
                      disabled={busy !== null || running}
                      title={running ? t("請先停止伺服器") : t("安裝最新測試版(含較新功能,可能不穩定)")}
                    >
                      {t("安裝測試版")}
                    </button>
                    {state.installed && (
                      <button
                        className={`${btnGhost} inline-flex items-center gap-1.5 text-berry hover:border-berry`}
                        onClick={() => uninstall(c.id)}
                        disabled={busy !== null || running}
                        title={running ? t("請先停止伺服器") : t("移除此模組")}
                      >
                        <FiTrash2 className="size-4" />
                        {busy === c.id ? t("處理中…") : t("移除")}
                      </button>
                    )}
                  </div>
                  {c.id === "paldefender" && (
                    <p className="mt-2 text-xs text-ink-muted">
                      {t("「玩家細節(查看帕魯/背包)」需要 v1.8.0 以上的測試版才支援。")}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[13px] text-ink-muted">{t("安裝或更新後,重啟伺服器才會生效。")}</p>

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
          <p className="text-[13px] text-ink-muted">
            {mods.luaModsDir === null
              ? t("尚無 Lua 模組。先安裝 UE4SS,之後就能在此上傳與管理模組。")
              : t("尚無 Lua 模組。用上方的「開啟 Lua 模組資料夾」上傳模組資料夾。")}
          </p>
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

      <div className={card}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-ink-muted">{t("Pak 模組")}</h3>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setBrowsing("Pal/Content/Paks")}
          >
            <FiFolder className="size-4" /> {t("開啟 Paks 資料夾")}
          </button>
        </div>
        {mods.pakMods.length === 0 ? (
          <p className="text-[13px] text-ink-muted">
            {t("尚無 Pak 模組。用上方的「開啟 Paks 資料夾」上傳 .pak 檔(Blueprint 模組放 LogicMods 子資料夾)。")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {mods.pakMods.map((name) => (
              <li key={name} className="text-sm font-bold">
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={card}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-ink-muted">{t("伺服器檔案")}</h3>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setBrowsing("")}
          >
            <FiFolder className="size-4" /> {t("瀏覽全部")}
          </button>
        </div>
        <p className="text-[13px] text-ink-muted">
          {t("直接編輯、上傳或刪除伺服器目錄裡的檔案(例如 PalDefender 的 Config.json)。")}
        </p>
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
}: {
  pakMods: { name: string; size: number; enabled: boolean }[];
  busy: boolean;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
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
      </div>
      <p className="mb-3 text-[13px] text-ink-muted">
        {t(".pak 檔放入 Pal/Content/Paks/ 後由遊戲引擎自動載入,不需 UE4SS。透過檔案管理上傳 pak 後在此管理。")}
      </p>
      {pakMods.length === 0 ? (
        <p className="text-[13px] text-ink-muted">{t("目前沒有 pak 模組。")}</p>
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

