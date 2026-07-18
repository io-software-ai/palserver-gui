import { useEffect, useState } from "react";
import { FiGlobe, FiHome, FiLock, FiMoon, FiRefreshCw, FiStar, FiUser, FiUsers, FiX } from "react-icons/fi";
import { hasFeature, type PublicMapSettings, type PublicMapStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { CopyPath } from "./CopyPath";
import { t, useI18n } from "./i18n";
import { Overlay, Select, btnGhost, card, errorCls, inputCls } from "./ui";

/**
 * 公開地圖設定彈窗:服主開關「把過濾後的地圖快照定時推到雲端 viewer」、調細項
 * 隱私設定、拿/重生分享連結。API 見 api.ts 的 publicMap/updatePublicMap/
 * rotatePublicMapLink,型別在 @palserver/shared(PublicMapSettings/PublicMapStatus)。
 *
 * 互動:任何設定變更都直接 PUT,樂觀更新畫面、失敗則還原並顯示錯誤(與地圖分頁其
 * 他即時開關一致的風格)。
 *
 * 贊助者先行版(public-map):未解鎖時總開關與細項一律鎖住(pointer-events-none),
 * 樣式與判斷方式照 TeleportModal 的模式 —— client.license() 拿授權狀態,
 * hasFeature("public-map", l) 判斷。實際的開關/換連結授權由 agent 端把關,這裡只是
 * 對應的顯示層引導(見 packages/agent/src/routes.ts 的 public-map 路由)。
 */
export function PublicMapModal({
  client,
  instanceId,
  onClose,
}: {
  client: AgentClient;
  instanceId: string;
  onClose: () => void;
}) {
  useI18n();
  const [status, setStatus] = useState<PublicMapStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entitled, setEntitled] = useState<boolean | null>(null);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("public-map", l)))
      .catch(() => setEntitled(false));
  }, [client, instanceId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client
      .publicMap(instanceId)
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, instanceId]);

  const locked = entitled === false;

  const patch = async (partial: Partial<PublicMapSettings>) => {
    if (!status) return;
    const prev = status;
    // 樂觀更新:先套用到畫面,PUT 失敗再還原。
    setStatus({ ...status, settings: { ...status.settings, ...partial } });
    setSaving(true);
    setError(null);
    try {
      setStatus(await client.updatePublicMap(instanceId, partial));
    } catch (err) {
      setStatus(prev);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    if (
      !confirm(
        t("重生分享連結後,舊連結將立即失效,已拿到舊連結的人將無法再開啟。確定要重生嗎?"),
      )
    )
      return;
    setRotating(true);
    setError(null);
    try {
      setStatus(await client.rotatePublicMapLink(instanceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRotating(false);
    }
  };

  const settings = status?.settings;
  const enabled = settings?.enabled ?? false;
  const busy = saving || rotating;

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[86vh] w-160 max-w-full flex-col gap-3 overflow-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiGlobe className="size-5 text-pal" /> {t("公開地圖")}
            <span className="inline-flex items-center gap-1 rounded-full bg-pal/10 px-2 py-0.5 text-xs font-bold text-pal">
              <FiStar className="size-3" /> {t("贊助者")}
            </span>
          </h2>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>

        {loading && <p className="text-sm text-ink-muted">{t("載入中…")}</p>}
        {error && <p className={errorCls}>{error}</p>}

        {locked && (
          <div className="inline-flex items-center gap-2 rounded-cute border-2 border-sun/40 bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
            <FiLock className="size-4 shrink-0" />
            {t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}
          </div>
        )}

        {settings && (
          <div className={locked ? "pointer-events-none flex flex-col gap-3 opacity-55" : "flex flex-col gap-3"}>
            <div className="flex items-start justify-between gap-3 rounded-xl border-2 border-line bg-card-soft px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-extrabold">{t("公開這個地圖")}</p>
                {enabled && (
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {t("將把下列資訊定期發布到公開網頁,任何拿到連結的人都能查看。")}
                  </p>
                )}
              </div>
              <SwitchButton
                checked={enabled}
                disabled={busy}
                onChange={(v) => void patch({ enabled: v })}
                label={t("公開這個地圖")}
              />
            </div>

            {enabled && (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold text-ink-muted">{t("分享連結")}</span>
                  <div className="flex items-center gap-2">
                    {status?.shareUrl ? (
                      <CopyPath value={status.shareUrl} className={`${inputCls} min-w-0 flex-1`} />
                    ) : (
                      <span className={`${inputCls} min-w-0 flex-1 text-ink-muted`}>
                        {t("尚未產生連結")}
                      </span>
                    )}
                    <button
                      type="button"
                      className={`${btnGhost} inline-flex shrink-0 items-center gap-1.5`}
                      onClick={() => void rotate()}
                      disabled={busy}
                    >
                      <FiRefreshCw className={`size-4 ${rotating ? "animate-spin" : ""}`} />
                      {rotating ? t("重生中…") : t("重生連結")}
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-bold text-ink-muted">{t("顯示內容")}</span>
                  <ToggleRow
                    icon={<FiUsers className="size-4" />}
                    label={t("顯示在線玩家位置")}
                    checked={settings.showPlayers}
                    disabled={busy}
                    onChange={(v) => void patch({ showPlayers: v })}
                  />
                  <ToggleRow
                    icon={<FiUser className="size-4" />}
                    label={t("顯示玩家名稱")}
                    hint={t("關閉時顯示匿名代號")}
                    checked={settings.showPlayerNames}
                    disabled={busy}
                    onChange={(v) => void patch({ showPlayerNames: v })}
                  />
                  <ToggleRow
                    icon={<FiMoon className="size-4" />}
                    label={t("顯示離線玩家最後位置")}
                    checked={settings.showOfflinePlayers}
                    disabled={busy}
                    onChange={(v) => void patch({ showOfflinePlayers: v })}
                  />
                  <ToggleRow
                    icon={<FiHome className="size-4" />}
                    label={t("顯示公會據點")}
                    checked={settings.showBases}
                    disabled={busy}
                    onChange={(v) => void patch({ showBases: v })}
                  />
                  <ToggleRow
                    icon={<FiUsers className="size-4" />}
                    label={t("顯示公會名稱")}
                    checked={settings.showGuildNames}
                    disabled={busy}
                    onChange={(v) => void patch({ showGuildNames: v })}
                  />
                </div>

                <label className="flex flex-col gap-1.5 text-xs font-bold text-ink-muted">
                  {t("延遲發布")}
                  <Select
                    value={String(settings.delayMinutes)}
                    onChange={(e) =>
                      void patch({ delayMinutes: Number(e.target.value) as 0 | 5 | 15 })
                    }
                  >
                    <option value="0">{t("即時")}</option>
                    <option value="5">{t("延遲 5 分鐘")}</option>
                    <option value="15">{t("延遲 15 分鐘")}</option>
                  </Select>
                  <span className="text-[11px] font-normal text-ink-muted">
                    {t("防止其他玩家即時追蹤位置")}
                  </span>
                </label>

                <div className="rounded-xl bg-card-soft px-3 py-2 text-[13px]">
                  {status?.lastPublish ? (
                    status.lastPublish.ok ? (
                      <p className="font-bold text-grass">
                        {t("上次發布成功:{time}", {
                          time: new Date(status.lastPublish.at).toLocaleString(),
                        })}
                      </p>
                    ) : (
                      <p className="font-bold text-berry">
                        {t("上次發布失敗:{time}", {
                          time: new Date(status.lastPublish.at).toLocaleString(),
                        })}
                        {status.lastPublish.error && (
                          <span className="mt-0.5 block font-normal">{status.lastPublish.error}</span>
                        )}
                      </p>
                    )
                  ) : (
                    <p className="text-ink-muted">{t("尚未發布過")}</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Overlay>
  );
}

/** 小型 iOS 風開關;role="switch" 與引擎頁的布林開關同款(EngineTab.tsx)。 */
function SwitchButton({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-60 ${
        checked ? "bg-grass" : "bg-line"
      }`}
    >
      <span
        className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${
          checked ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}

function ToggleRow({
  icon,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border-2 border-line px-3 py-2">
      <span className="inline-flex min-w-0 items-center gap-2 text-sm font-bold">
        {icon}
        <span className="truncate">{label}</span>
        {hint && <span className="text-xs font-normal text-ink-muted">({hint})</span>}
      </span>
      <SwitchButton checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}
