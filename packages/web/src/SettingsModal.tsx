import { useEffect, useState } from "react";
import { FiX, FiCopy, FiCheck, FiRefreshCw, FiSmartphone, FiKey, FiWifi, FiTrash2, FiStar } from "react-icons/fi";
import type { LicenseStatus } from "@palserver/shared";
import type { AgentClient, Connection, TelemetryStatus } from "./api";
import { copyText } from "./clipboard";
import { PrivacyModal } from "./PrivacyModal";
import { UpdateCard } from "./UpdateCard";
import { useI18n } from "./i18n";
import { Overlay, card, btn, btnGhost } from "./ui";

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
  const [addrs, setAddrs] = useState<{ ip: string; vpn: string | null }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryStatus | null>(null);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  const [licInput, setLicInput] = useState("");
  const [licBusy, setLicBusy] = useState(false);

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
            <Copyable text={code ?? "…"} mono big />
          </div>

          {addrs && addrs.length > 0 ? (
            // agent 已把最適合遠端連線的位址(Tailscale/VPN 優先)排在最前面,
            // 只給那一條 —— 列出一堆區網位址反而讓人不知道該複製哪個。
            <div>
              <p className="mb-1 text-xs font-bold text-ink-muted">{t("一鍵登入連結(複製給其他裝置打開)")}</p>
              <div className="flex items-center gap-2">
                <Copyable text={linkFor(addrs[0].ip)} mono />
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

        {/* GUI 自我更新(對接 GitHub Releases) */}
        <UpdateCard client={client} />

        {/* 贊助者識別碼(先行版) */}
        {lic && (
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
function licReason(t: (s: string) => string, reason: string | null): string {
  switch (reason) {
    case "invalid":
      return t("識別碼不存在");
    case "bound-to-another":
      return t("此識別碼已綁定另一台伺服器");
    case "expired":
      return t("識別碼已到期");
    case "offline":
      return t("暫時連不上驗證伺服器(離線寬限期已過)");
    default:
      return t("驗證失敗");
  }
}

function Copyable({ text, mono, big }: { text: string; mono?: boolean; big?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <button
      onClick={copy}
      title={t("點擊複製")}
      className={`flex w-full items-center justify-between gap-2 rounded-lg border-2 border-line bg-card-soft px-3 py-2 text-left transition hover:border-pal ${
        mono ? "font-mono" : ""
      } ${big ? "text-lg font-bold tracking-widest" : "text-sm"}`}
    >
      <span className="truncate">{text}</span>
      {copied ? (
        <FiCheck className="size-4 shrink-0 text-grass" />
      ) : (
        <FiCopy className="size-4 shrink-0 text-ink-muted" />
      )}
    </button>
  );
}
