import { useCallback, useEffect, useMemo, useState } from "react";
import { FiCheck, FiCopy, FiExternalLink } from "react-icons/fi";
import { hasFeature } from "@palserver/shared";
import type { DiscordBotStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { CopyPath } from "./CopyPath";
import { copyText } from "./clipboard";
import { t, useI18n } from "./i18n";
import { SponsorLockNotice, btn, btnDanger, btnGhost, card, inputCls, labelCls } from "./ui";

/**
 * 「Discord Bot」分頁。兩種部署:
 *  - 同機自動執行(推薦):貼 token → agent self-fork 一個 bot 子行程並監督(見 discord-bot-manager.ts)。
 *  - 進階/跨機:把 bot 跑在另一台機器或 Docker(下方折疊區的引導 + .env 範本 + 連線資訊)。
 * 通知方向走「Webhook」分頁(format:discord);這頁只管「從 Discord 下指令」。
 */

function CopyBlock({ text }: { text: string }) {
  useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-line bg-sky-soft p-3 pr-10 text-xs leading-relaxed text-ink">
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        title={t("點擊複製")}
        className="absolute right-2 top-2 text-ink-muted transition hover:text-pal"
      >
        {copied ? <FiCheck className="size-4 text-grass" /> : <FiCopy className="size-4" />}
      </button>
    </div>
  );
}

function CredentialRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  return (
    <label className={labelCls}>
      <span>{label}</span>
      <CopyPath value={value} secret={secret} className="rounded-lg border border-line bg-sky-soft px-3 py-2 text-sm" />
    </label>
  );
}

const COMMANDS: { name: string; desc: string; admin: boolean }[] = [
  { name: "/players", desc: "查看在線玩家", admin: false },
  { name: "/status", desc: "查看伺服器狀態", admin: false },
  { name: "/broadcast", desc: "遊戲內廣播訊息", admin: true },
  { name: "/save", desc: "立即存檔", admin: true },
  { name: "/restart", desc: "重啟伺服器", admin: true },
  { name: "/kick", desc: "踢出在線玩家", admin: true },
  { name: "/ban", desc: "封鎖玩家", admin: true },
  { name: "/rcon", desc: "執行 RCON 指令", admin: true },
];

const DEV_PORTAL = "https://discord.com/developers/applications";

export function DiscordBotTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [addresses, setAddresses] = useState<{ ip: string; vpn: string | null }[]>([]);
  const [status, setStatus] = useState<DiscordBotStatus | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("webhooks", l)))
      .catch(() => setEntitled(false));
  }, [client]);

  useEffect(() => {
    if (!entitled) return;
    client
      .agentAddresses()
      .then((r) => setAddresses(r.addresses))
      .catch(() => {});
  }, [client, entitled]);

  // 同機狀態:掛載即拉一次,之後每 5s 輪詢(bot 子行程崩潰/連上會反映在 running / lastError)。
  const refreshStatus = useCallback(() => {
    client
      .discordBot(instanceId)
      .then(setStatus)
      .catch(() => {});
  }, [client, instanceId]);

  useEffect(() => {
    if (!entitled) return;
    refreshStatus();
    const timer = setInterval(refreshStatus, 5000);
    return () => clearInterval(timer);
  }, [entitled, refreshStatus]);

  const mutate = useCallback(
    async (patch: { enabled?: boolean; token?: string }): Promise<DiscordBotStatus | null> => {
      setBusy(true);
      setErr(null);
      try {
        const next = await client.setDiscordBot(instanceId, patch);
        setStatus(next);
        return next;
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [client, instanceId],
  );

  const saveToken = async () => {
    const tk = tokenInput.trim();
    if (!tk) return;
    const next = await mutate({ token: tk });
    if (next) {
      setTokenInput("");
      setEditingToken(false);
    }
  };
  const clearToken = async () => {
    await mutate({ token: "", enabled: false });
    setTokenInput("");
    setEditingToken(false);
  };

  // 建議的 AGENT_URL(跨機用):優先給 VPN / Tailscale 位址,否則第一個區網位址;沿用目前 scheme 與 port。
  const agentUrl = useMemo(() => {
    let scheme = "http:";
    let port = "8250";
    try {
      const u = new URL(client.baseUrl);
      scheme = u.protocol;
      port = u.port || (scheme === "https:" ? "443" : "80");
    } catch {
      /* baseUrl 解析失敗就用預設 */
    }
    const pick = addresses.find((a) => a.vpn) ?? addresses[0];
    return pick ? `${scheme}//${pick.ip}:${port}` : client.baseUrl;
  }, [client, addresses]);

  const envTemplate = useMemo(
    () =>
      [
        "DISCORD_TOKEN=（你的 bot token）",
        `AGENT_URL=${agentUrl}`,
        "AGENT_TOKEN=（貼上下方的存取權杖）",
        `AGENT_INSTANCE_ID=${instanceId}`,
      ].join("\n"),
    [agentUrl, instanceId],
  );

  if (entitled === false) {
    return (
      <div className="flex flex-col gap-4">
        <SponsorLockNotice>
          {t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}
        </SponsorLockNotice>
      </div>
    );
  }

  const tokenSet = !!status?.tokenSet;
  const enabled = !!status?.settings.enabled;

  let statusText: string;
  let statusTone: string;
  if (!tokenSet) {
    statusText = t("尚未設定 token");
    statusTone = "text-ink-muted";
  } else if (!enabled) {
    statusText = t("已停用");
    statusTone = "text-ink-muted";
  } else if (status?.running) {
    statusText = t("執行中");
    statusTone = "text-grass";
  } else if (status?.lastError) {
    statusText = status.lastError;
    statusTone = "text-sun";
  } else {
    statusText = t("啟動中…");
    statusTone = "text-ink-muted";
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={card}>
        <h3 className="text-base font-extrabold">{t("官方 Discord 機器人")}</h3>
        <p className="mt-1 text-sm text-ink-muted">
          {t("在 Discord 用 /players、/restart、/broadcast 等指令直接操作伺服器。這是一個獨立的自架服務,只對外連線、不需要對外開放連接埠(可走 Tailscale)。")}
        </p>
        <p className="mt-2 text-xs text-ink-muted">
          {t("事件通知(玩家上線、死亡等)請到「Webhook」分頁設定;這頁只負責「從 Discord 下指令」。")}
        </p>
      </section>

      <section className={card}>
        <h4 className="text-sm font-extrabold">{t("在這台機器上自動執行(推薦)")}</h4>
        <p className="mt-1 text-xs text-ink-muted">
          {t("貼上 Discord bot token,由這台 agent 直接把 bot 跑起來並自動維持 —— 免 Docker、免 Node、免手動註冊指令。token 只存在這台機器,不會回傳到瀏覽器。")}
        </p>

        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-[13px] font-bold text-ink-muted">{t("Discord Bot Token")}</span>
          {tokenSet && !editingToken ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-1 font-bold text-grass">
                <FiCheck className="size-4" />
                {t("已設定")}
              </span>
              <button
                type="button"
                className={btnGhost}
                onClick={() => {
                  setEditingToken(true);
                  setTokenInput("");
                }}
              >
                {t("更換")}
              </button>
              <button type="button" className={btnDanger} onClick={clearToken} disabled={busy}>
                {t("清除")}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={t("貼上 bot token")}
                className={`${inputCls} min-w-0 flex-1`}
              />
              <button type="button" className={btn} onClick={saveToken} disabled={busy || !tokenInput.trim()}>
                {t("儲存")}
              </button>
              {tokenSet && (
                <button type="button" className={btnGhost} onClick={() => setEditingToken(false)}>
                  {t("取消")}
                </button>
              )}
            </div>
          )}
          <p className="text-[11px] text-ink-muted">
            {t("還沒有 token?到 Discord 開發者後台建立 Bot 並邀請進你的伺服器(步驟見下方「進階」)。")}{" "}
            <a
              href={DEV_PORTAL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-pal hover:underline"
            >
              {t("開發者後台")}
              <FiExternalLink className="size-3" />
            </a>
          </p>
        </div>

        <label className="mt-3 inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-bold">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || (!tokenSet && !enabled)}
            onChange={(e) => void mutate({ enabled: e.target.checked })}
          />
          {t("啟用")}
        </label>
        {!tokenSet && <p className="mt-1 text-[11px] font-bold text-sun">{t("請先設定 token 再啟用。")}</p>}

        <div className="mt-3 text-sm">
          <span className="text-ink-muted">{t("狀態")}</span>
          <span className="text-ink-muted">:</span> <span className={`font-bold ${statusTone}`}>{statusText}</span>
        </div>
        {err && <p className="mt-1 text-[11px] font-bold text-berry">{err}</p>}
      </section>

      <section className={card}>
        <h4 className="text-sm font-extrabold">{t("可用指令")}</h4>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {COMMANDS.map((c) => (
            <li key={c.name} className="flex items-baseline gap-2 text-sm">
              <code className="rounded bg-sky-soft px-1.5 py-0.5 font-mono text-xs text-pal-strong">{c.name}</code>
              <span className="text-ink-muted">{t(c.desc)}</span>
              {c.admin && <span className="ml-auto shrink-0 text-[11px] text-ink-muted">{t("管理員")}</span>}
            </li>
          ))}
        </ul>
      </section>

      <div>
        <button
          type="button"
          className="text-sm font-bold text-pal hover:underline"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? t("隱藏進階設定") : t("進階:在另一台機器 / 用 Docker 執行")}
        </button>
      </div>

      {showAdvanced && (
        <>
          <section className={card}>
            <h4 className="text-sm font-extrabold">{t("設定步驟")}</h4>
            <p className="mt-1 text-xs text-ink-muted">
              {t("以下步驟是把 bot 跑在「另一台機器」或用 Docker 自架時才需要;同機自動執行不用。")}
            </p>
            <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-sm text-ink">
              <li>
                {t("到 Discord 開發者後台建立應用程式與 Bot,取得 Bot Token。")}{" "}
                <a
                  href={DEV_PORTAL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-pal hover:underline"
                >
                  {t("開發者後台")}
                  <FiExternalLink className="size-3" />
                </a>
              </li>
              <li>{t("把 Bot 邀請進你的 Discord 伺服器。")}</li>
              <li>{t("把下方的 agent 連線資訊填進 bot 的 .env(範本如下)。")}</li>
              <li>{t("用 docker compose up -d 或 pnpm start 啟動 bot;slash 指令會在 bot 上線時自動註冊。詳見 packages/discord-bot/README。")}</li>
            </ol>
          </section>

          <section className={card}>
            <h4 className="text-sm font-extrabold">{t("這台 agent 的連線資訊")}</h4>
            <p className="mt-1 text-xs text-ink-muted">
              {t("填進 bot 的 .env。存取權杖等同 agent 的完整控制權,請妥善保管、不要外流。")}
            </p>
            <div className="mt-3 flex flex-col gap-3">
              <CredentialRow label={t("Agent 連線網址")} value={agentUrl} />
              <CredentialRow label={t("存取權杖(AGENT_TOKEN)")} value={client.token} secret />
              <CredentialRow label={t("實例 ID(AGENT_INSTANCE_ID)")} value={instanceId} />
            </div>
          </section>

          <section className={card}>
            <h4 className="text-sm font-extrabold">{t(".env 範本")}</h4>
            <p className="mt-1 text-xs text-ink-muted">{t("把 DISCORD_TOKEN 換成你的 bot token,AGENT_TOKEN 貼上上方的權杖。")}</p>
            <div className="mt-2">
              <CopyBlock text={envTemplate} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
