import { useEffect, useState } from "react";
import { FiX, FiCopy, FiCheck, FiRefreshCw, FiSmartphone, FiKey, FiWifi, FiTrash2, FiStar, FiEye, FiEyeOff, FiSun, FiShield } from "react-icons/fi";
import type { LicenseStatus } from "@palserver/shared";
import type { AgentClient, Connection, TelemetryStatus, AgentSettingsStatus, AgentSettingsPatch } from "./api";
import { copyText } from "./clipboard";
import { PrivacyModal } from "./PrivacyModal";
import { UpdateCard } from "./UpdateCard";
import { useI18n } from "./i18n";
import { SHOW_SPONSOR_FEATURES } from "./flags";
import { ThemePicker } from "./ThemePicker";
import { useHiddenCards } from "./tabPrefs";
import { Overlay, card, btn, btnGhost, inputCls } from "./ui";

/**
 * 設定頁:主要用來在「其他裝置」連進這台 agent —— 顯示配對碼、以及各個可連位址
 * (區網 / Tailscale)組好的一次性登入連結,可一鍵複製。也提供重新產生配對碼,
 * 以及進階的 API token(給自動化用)。
 */
export function SettingsModal({
  client,
  conn,
  onClose,
}: {
  client: AgentClient;
  conn: Connection;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState<string | null>(null);
  const [hiddenCards, setHiddenCards] = useHiddenCards();
  const [addrs, setAddrs] = useState<{ ip: string; vpn: string | null }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryStatus | null>(null);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  const [licInput, setLicInput] = useState("");
  const [licBusy, setLicBusy] = useState(false);
  const [showThemes, setShowThemes] = useState(false);

  useEffect(() => {
    client.pairingCode().then((r) => setCode(r.pairingCode)).catch(() => setCode(null));
    client.agentAddresses().then((r) => setAddrs(r.addresses)).catch(() => setAddrs([]));
    client.telemetry().then(setTelemetry).catch(() => setTelemetry(null));
    client.license().then(setLic).catch(() => setLic(null));
  }, [client]);

  const saveLicense = async () => {
    if (!licInput.trim()) return;
    setLicBusy(true);
    try {
      setLic(await client.setLicense(licInput.trim()));
      setLicInput("");
    } finally {
      setLicBusy(false);
    }
  };
  const clearLicense = async () => {
    setLicBusy(true);
    try {
      setLic(await client.clearLicense());
    } finally {
      setLicBusy(false);
    }
  };

  // 用自己連進來的網址推得 scheme 與 port,組給其他裝置的登入連結。
  let scheme = "http:";
  let port = "8250";
  try {
    const u = new URL(conn.url);
    scheme = u.protocol;
    port = u.port || (scheme === "https:" ? "443" : "80");
  } catch {
    /* 保底 */
  }
  const linkFor = (ip: string) => `${scheme}//${ip}:${port}/?setup=${code ?? ""}`;

  const rotate = async () => {
    if (!confirm(t("重新產生配對碼?\n\n舊的配對碼與登入連結會立刻失效,已連線的裝置不受影響。"))) return;
    setBusy(true);
    try {
      const r = await client.rotatePairingCode();
      setCode(r.pairingCode);
    } finally {
      setBusy(false);
    }
  };

  const clearData = () => {
    if (
      !confirm(
        t("清除這個瀏覽器上的暫存資料?\n\n會清掉:已儲存的連線、看過的公告、地圖校正、偏好設定等。\n頁面會重新整理,伺服器與存檔完全不受影響。"),
      )
    ) {
      return;
    }
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* 忽略 */
    }
    // 逐一讓 cookie 過期
    for (const c of document.cookie.split(";")) {
      const name = c.split("=")[0].trim();
      if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    }
    location.reload();
  };

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[85vh] w-[540px] max-w-full flex-col gap-4 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiSmartphone className="size-5 text-pal" /> {t("設定")}
          </h2>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>

        {/* 在其他裝置連線 */}
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-extrabold">{t("在其他裝置連線")}</h3>
          <p className="text-[13px] text-ink-muted">
            {t("想在手機或另一台電腦管理這台伺服器?在那台裝置的瀏覽器打開下面的連結(或打開 agent 網址後輸入配對碼)即可登入。對方需要和這台主機在同一區網或 VPN 內。")}
          </p>

          <div>
            <p className="mb-1 text-xs font-bold text-ink-muted">{t("配對碼")}</p>
            <Copyable text={code ?? "…"} mono big secret />
          </div>

          {addrs && addrs.length > 0 ? (
            // agent 已把最適合遠端連線的位址(Tailscale/VPN 優先)排在最前面,
            // 只給那一條 —— 列出一堆區網位址反而讓人不知道該複製哪個。
            <div>
              <p className="mb-1 text-xs font-bold text-ink-muted">{t("一鍵登入連結(複製給其他裝置打開)")}</p>
              <div className="flex items-center gap-2">
                <Copyable text={linkFor(addrs[0].ip)} mono secret />
                {addrs[0].vpn && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border-[1.5px] border-pal/40 bg-pal/10 px-2 py-0.5 text-xs font-bold text-pal">
                    <FiWifi className="size-3" /> {addrs[0].vpn}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <p className="rounded-xl bg-card-soft px-3 py-2 text-xs text-ink-muted">
              {t("偵測不到區網/VPN 位址。若要讓其他裝置連線,請確認這台主機已連上區網或 VPN,並用該位址(例如 Tailscale 的 100.x)加上")}{" "}
              <span className="font-mono">/?setup={t("配對碼")}</span> {t("開啟。")}
            </p>
          )}

          <div>
            <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={rotate} disabled={busy}>
              <FiRefreshCw className="size-4" /> {busy ? t("產生中…") : t("重新產生配對碼")}
            </button>
            <p className="mt-1 text-xs text-ink-muted">{t("舊連結外流時可重設;重設後舊的配對碼即失效。")}</p>
          </div>
        </div>

        {/* 贊助者識別碼(先行版)—— 未公布前用 SHOW_SPONSOR_FEATURES 隱藏 */}
        {SHOW_SPONSOR_FEATURES && lic && (
          <div className="border-t border-line pt-3">
            <h3 className="inline-flex items-center gap-1.5 text-sm font-extrabold">
              <FiStar className="size-4 text-pal" /> {t("贊助者識別碼")}
            </h3>
            <p className="mt-1 text-xs text-ink-muted">
              {t("輸入贊助者識別碼即可搶先體驗先行版功能。一組識別碼只能綁定一台伺服器,這台的機器碼為")}{" "}
              <span className="font-mono">{lic.machineId}</span>。
            </p>
            {lic.hasKey ? (
              <div className="mt-2 flex flex-col gap-2">
                <div
                  className={`inline-flex w-fit items-center gap-1.5 rounded-full border-[1.5px] px-2.5 py-1 text-xs font-bold ${
                    lic.valid
                      ? "border-grass/40 bg-grass/10 text-grass"
                      : "border-sun/50 bg-sun/10 text-sun"
                  }`}
                >
                  {lic.valid ? (
                    <>
                      <FiCheck className="size-3.5" />
                      {t("已啟用")}
                      {lic.tier ? ` · ${lic.tier}` : ""}
                      {lic.expiresAt ? ` · ${t("有效至")} ${lic.expiresAt.slice(0, 10)}` : ""}
                    </>
                  ) : (
                    <>{t("無法啟用")}:{licReason(t, lic.reason)}</>
                  )}
                </div>
                <button className={`${btnGhost} inline-flex w-fit items-center gap-1.5`} onClick={clearLicense} disabled={licBusy}>
                  <FiTrash2 className="size-4" /> {t("移除識別碼")}
                </button>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className="min-w-0 flex-1 rounded-lg border-2 border-line bg-card px-3 py-1.5 font-mono text-sm outline-none focus:border-pal"
                  placeholder="PAL-XXXX-XXXX-XXXX"
                  value={licInput}
                  onChange={(e) => setLicInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void saveLicense()}
                />
                <button className={`${btn} inline-flex items-center gap-1.5`} onClick={saveLicense} disabled={licBusy || !licInput.trim()}>
                  {licBusy ? t("驗證中…") : t("啟用")}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 外觀主題 */}
        <div className="border-t border-line pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-extrabold">{t("外觀主題")}</h3>
              <p className="mt-1 text-xs text-ink-muted">
                {t("深 / 淺色與主題風格。白銀、翡翠為贊助者專屬。")}
              </p>
            </div>
            <button
              className={`${btnGhost} inline-flex shrink-0 items-center gap-1.5`}
              onClick={() => setShowThemes(true)}
            >
              <FiSun className="size-4" /> {t("選擇主題")}
            </button>
          </div>
        </div>

        {/* 右下角貓貓:可整隻關掉(hiddenCards 全域偏好,Mascot 讀同一份) */}
        <div className="border-t border-line pt-3">
          <h3 className="text-sm font-extrabold">{t("右下角貓貓")}</h3>
          <p className="mt-1 text-xs text-ink-muted">
            {t("首頁右下角打呼的貓貓(作者家的貓),點牠會打開贊助小視窗。")}
          </p>
          <label className="mt-2 flex items-center gap-2 text-[13px] font-bold text-ink-muted">
            <input
              type="checkbox"
              className="accent-pal"
              checked={!hiddenCards.includes("mascot")}
              onChange={(e) =>
                setHiddenCards(
                  e.target.checked
                    ? hiddenCards.filter((id) => id !== "mascot")
                    : [...hiddenCards, "mascot"],
                )
              }
            />
            {t("顯示貓貓")}
          </label>
        </div>

        {/* GUI 自我更新(對接 GitHub Releases) */}
        <UpdateCard client={client} />

        {/* 進階:API token */}
        <div className="border-t border-line pt-3">
          <button
            className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ink-muted hover:text-ink"
            onClick={() => setShowToken((v) => !v)}
          >
            <FiKey className="size-4" /> {t("進階:API token(自動化用)")}
          </button>
          {showToken &&
            (conn.token ? (
              <div className="mt-2">
                <Copyable text={conn.token} mono />
              </div>
            ) : (
              <p className="mt-2 rounded-xl bg-card-soft px-3 py-2 text-xs text-ink-muted">
                {t("你目前是本機免密碼連線,手上沒有 token。API token 顯示在 agent 啟動的視窗裡(標示「API token」那行)。")}
              </p>
            ))}
        </div>

        {/* 安全 / 網路設定(進階,可折疊) */}
        <SecuritySettings client={client} />

        {/* 匿名使用統計 */}
        {telemetry && (
          <div className="border-t border-line pt-3">
            <h3 className="text-sm font-extrabold">{t("匿名使用統計")}</h3>
            <p className="mt-1 text-xs text-ink-muted">
              {t("回報匿名的使用計數(安裝數、伺服器建立/啟動數、不重複玩家數),幫助我們了解使用規模。")}
              <b className="text-ink">{t("不含任何個資、IP、伺服器名稱或存檔內容")}</b>{t(",詳見")}
              <button className="underline underline-offset-2 hover:text-pal" onClick={() => setShowPrivacy(true)}>
                {t("隱私權政策")}
              </button>
              。
            </p>
            {telemetry.envDisabled ? (
              <p className="mt-2 rounded-xl bg-card-soft px-3 py-2 text-xs text-ink-muted">
                {t("已由環境變數")} <span className="font-mono">PALSERVER_TELEMETRY=0</span> {t("強制停用。")}
              </p>
            ) : (
              <label className="mt-2 flex items-center gap-2 text-[13px] font-bold text-ink-muted">
                <input
                  type="checkbox"
                  className="accent-(--color-pal)"
                  checked={telemetry.enabled}
                  onChange={(e) => {
                    void client
                      .setTelemetry(e.target.checked)
                      .then(setTelemetry)
                      .catch(() => {});
                  }}
                />
                {t("參與匿名使用統計")}
              </label>
            )}
          </div>
        )}
        {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
        {showThemes && <ThemePicker entitled={!!lic?.valid} onClose={() => setShowThemes(false)} />}

        {/* 清除暫存資料 */}
        <div className="border-t border-line pt-3">
          <h3 className="text-sm font-extrabold">{t("清除暫存資料")}</h3>
          <p className="mt-1 text-xs text-ink-muted">
            {t("清掉這個瀏覽器上存的連線、看過的公告與偏好設定(localStorage / cookie)。遇到畫面卡舊資料、或想登出重連時很有用。")}
            <b className="text-ink">{t("不會動到伺服器與存檔。")}</b>
          </p>
          <button
            className={`${btnGhost} mt-2 inline-flex items-center gap-1.5 text-berry hover:border-berry`}
            onClick={clearData}
          >
            <FiTrash2 className="size-4" /> {t("清除暫存並重新整理")}
          </button>
        </div>

        <div className="flex justify-end">
          <button className={btn} onClick={onClose}>
            {t("完成")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/** 把 worker 回的無效原因碼轉成友善說明。 */
/** 可折疊的「安全 / 網路設定」:對應 agent 的 /api/settings。改動寫進 settings.json,重啟後生效;
 *  由環境變數設定的欄位以環境變數為準、灰化不可改(env > settings.json)。 */
function SecuritySettings({ client }: { client: AgentClient }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<AgentSettingsStatus | null>(null);
  const [form, setForm] = useState<AgentSettingsPatch>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!open || st) return;
    client
      .agentSettings()
      .then((s) => {
        setSt(s);
        setForm({
          requireToken: s.requireToken.value,
          tls: s.tls.value,
          agentPort: s.agentPort.value,
          agentHost: s.agentHost.value,
          webOrigins: s.webOrigins.value,
          autoOpenBrowser: s.autoOpenBrowser.value,
          bootStart: s.bootStart ?? undefined,
        });
      })
      .catch(() => {});
  }, [open, st, client]);

  const set = (patch: Partial<AgentSettingsPatch>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
  };

  const save = async () => {
    if (!st) return;
    setSaving(true);
    try {
      const p: AgentSettingsPatch = {};
      if (!st.requireToken.envLocked) p.requireToken = !!form.requireToken;
      if (!st.tls.envLocked) p.tls = !!form.tls;
      if (!st.agentPort.envLocked) p.agentPort = Number(form.agentPort) || 8250;
      if (!st.agentHost.envLocked) p.agentHost = (form.agentHost ?? "").trim() || "0.0.0.0";
      if (!st.webOrigins.envLocked) p.webOrigins = (form.webOrigins ?? "").trim();
      if (!st.autoOpenBrowser.envLocked) p.autoOpenBrowser = !!form.autoOpenBrowser;
      if (st.bootStart !== null) p.bootStart = !!form.bootStart;
      await client.saveAgentSettings(p);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    setRestarting(true);
    try {
      await client.restartAgent();
    } catch {
      setRestarting(false);
    }
  };

  const lock = (locked: boolean) =>
    locked ? <span className="ml-1.5 text-[11px] font-bold text-ink-muted">{t("(由環境變數鎖定)")}</span> : null;

  return (
    <div className="border-t border-line pt-3">
      <button
        className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ink-muted hover:text-ink"
        onClick={() => setOpen((v) => !v)}
      >
        <FiShield className="size-4" /> {t("安全 / 網路設定(進階)")}
      </button>

      {open && st && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="rounded-xl bg-card-soft px-3 py-2 text-xs text-ink-muted">
            {t("改動需重啟 agent 才生效。由環境變數設定的項目以環境變數為準,無法在此修改。")}
          </p>

          {st.bootStart !== null && (
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-pal"
                checked={!!form.bootStart}
                onChange={(e) => set({ bootStart: e.target.checked })}
              />
              <span className="text-[13px]">
                <b className="font-bold">{t("開機自動啟動 agent")}</b>
                <span className="block text-xs text-ink-muted">
                  {t("登入 Windows 時自動在背景啟動 agent。搭配伺服器「設定」分頁的「自動啟動」,主機開機即自動開服。儲存後立即生效。")}
                </span>
              </span>
            </label>
          )}

          <label className={`flex items-start gap-2.5 ${st.autoOpenBrowser.envLocked ? "opacity-50" : "cursor-pointer"}`}>
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-pal"
              checked={!!form.autoOpenBrowser}
              disabled={st.autoOpenBrowser.envLocked}
              onChange={(e) => set({ autoOpenBrowser: e.target.checked })}
            />
            <span className="text-[13px]">
              <b className="font-bold">{t("開機時自動開啟瀏覽器")}</b>
              {lock(st.autoOpenBrowser.envLocked)}
              <span className="block text-xs text-ink-muted">
                {t("agent 啟動時自動打開管理介面(下次啟動生效)。放伺服器的機器沒有螢幕時可關掉。")}
              </span>
            </span>
          </label>

          <label className={`flex items-start gap-2.5 ${st.requireToken.envLocked ? "opacity-50" : "cursor-pointer"}`}>
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-pal"
              checked={!!form.requireToken}
              disabled={st.requireToken.envLocked}
              onChange={(e) => set({ requireToken: e.target.checked })}
            />
            <span className="text-[13px]">
              <b className="font-bold">{t("強制要求識別碼(本機也要)")}</b>
              {lock(st.requireToken.envLocked)}
              <span className="block text-xs text-ink-muted">
                {t("透過 Cloudflare Tunnel / 反向代理對外曝露時務必開啟,否則任何連得到的人都能無密碼管理。")}
              </span>
            </span>
          </label>

          <label className={`flex items-start gap-2.5 ${st.tls.envLocked ? "opacity-50" : "cursor-pointer"}`}>
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-pal"
              checked={!!form.tls}
              disabled={st.tls.envLocked}
              onChange={(e) => set({ tls: e.target.checked })}
            />
            <span className="text-[13px]">
              <b className="font-bold">{t("以 HTTPS 監聽")}</b>
              {lock(st.tls.envLocked)}
              <span className="block text-xs text-ink-muted">
                {t("自簽憑證會自動生成於 data-dir/tls;也可放自己的憑證進去。")}
              </span>
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className={`flex flex-col gap-1 ${st.agentPort.envLocked ? "opacity-50" : ""}`}>
              <span className="text-xs font-bold text-ink-muted">
                {t("監聽埠")}
                {lock(st.agentPort.envLocked)}
              </span>
              <input
                type="number"
                min={1}
                max={65535}
                className={inputCls}
                value={form.agentPort ?? 8250}
                disabled={st.agentPort.envLocked}
                onChange={(e) => set({ agentPort: Number(e.target.value) })}
              />
            </label>
            <label className={`flex flex-col gap-1 ${st.agentHost.envLocked ? "opacity-50" : ""}`}>
              <span className="text-xs font-bold text-ink-muted">
                {t("監聽位址")}
                {lock(st.agentHost.envLocked)}
              </span>
              <input
                type="text"
                className={`${inputCls} font-mono`}
                value={form.agentHost ?? ""}
                disabled={st.agentHost.envLocked}
                placeholder="0.0.0.0"
                onChange={(e) => set({ agentHost: e.target.value })}
              />
            </label>
          </div>

          <label className={`flex flex-col gap-1 ${st.webOrigins.envLocked ? "opacity-50" : ""}`}>
            <span className="text-xs font-bold text-ink-muted">
              {t("允許的公開站來源(逗號分隔;純 web 版才需要)")}
              {lock(st.webOrigins.envLocked)}
            </span>
            <input
              type="text"
              className={`${inputCls} font-mono`}
              value={form.webOrigins ?? ""}
              disabled={st.webOrigins.envLocked}
              placeholder="https://panel.example.com"
              onChange={(e) => set({ webOrigins: e.target.value })}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className={`${btn} inline-flex items-center gap-1.5`} onClick={save} disabled={saving}>
              {saving ? t("儲存中…") : t("儲存")}
            </button>
            {saved &&
              (st.canRestart ? (
                <button
                  className={`${btnGhost} inline-flex items-center gap-1.5`}
                  onClick={restart}
                  disabled={restarting}
                >
                  <FiRefreshCw className="size-4" /> {restarting ? t("重啟中…") : t("重啟 agent 套用")}
                </button>
              ) : (
                <span className="text-xs font-bold text-sun">{t("已儲存,請手動重啟 agent 才會生效。")}</span>
              ))}
            {saved && st.canRestart && <span className="text-xs font-bold text-grass">{t("已儲存")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function licReason(t: (s: string) => string, reason: string | null): string {
  switch (reason) {
    case "invalid":
      return t("識別碼不存在");
    case "bound-to-another":
      return t("此識別碼已綁定另一台伺服器");
    case "expired":
      return t("識別碼已到期");
    case "unreachable":
      return t("連不上驗證伺服器,請確認這台伺服器主機能連上網際網路");
    case "offline":
      return t("暫時連不上驗證伺服器(離線寬限期已過)");
    default:
      return t("驗證失敗");
  }
}

function Copyable({
  text,
  mono,
  big,
  secret,
}: {
  text: string;
  mono?: boolean;
  big?: boolean;
  /** 敏感值(如配對碼):預設模糊遮蔽,點眼睛才顯示;複製一律複製真值。 */
  secret?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  const hidden = secret && !revealed;
  return (
    <button
      onClick={copy}
      title={t("點擊複製")}
      className={`flex w-full items-center justify-between gap-2 rounded-lg border-2 border-line bg-card-soft px-3 py-2 text-left transition hover:border-pal ${
        mono ? "font-mono" : ""
      } ${big ? "text-lg font-bold tracking-widest" : "text-sm"}`}
    >
      <span className={`truncate ${hidden ? "select-none blur-[6px]" : ""}`}>{text}</span>
      <span className="flex shrink-0 items-center gap-2">
        {secret && (
          <span
            role="button"
            tabIndex={0}
            title={hidden ? t("顯示") : t("隱藏")}
            className="text-ink-muted transition hover:text-pal"
            onClick={(e) => {
              e.stopPropagation();
              setRevealed((v) => !v);
            }}
          >
            {hidden ? <FiEye className="size-4" /> : <FiEyeOff className="size-4" />}
          </span>
        )}
        {copied ? (
          <FiCheck className="size-4 text-grass" />
        ) : (
          <FiCopy className="size-4 text-ink-muted" />
        )}
      </span>
    </button>
  );
}
