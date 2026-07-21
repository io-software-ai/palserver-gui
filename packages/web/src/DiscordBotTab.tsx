import { useCallback, useEffect, useMemo, useState } from "react";
import { FiCheck, FiCopy, FiExternalLink, FiX } from "react-icons/fi";
import { hasFeature } from "@palserver/shared";
import type { DiscordBotStatus, WebhookEventType } from "@palserver/shared";
import type { AgentClient } from "./api";
import { CopyPath } from "./CopyPath";
import { EventPicker } from "./WebhookSettingsTab";
import { copyText } from "./clipboard";
import { t, useI18n } from "./i18n";
import { SponsorLockNotice, btn, btnDanger, btnGhost, card, inputCls, labelCls } from "./ui";

/**
 * 「Discord Bot」分頁。兩種部署:
 *  - 同機自動執行(推薦):貼 token → agent self-fork 一個 bot 子行程並監督(見 discord-bot-manager.ts)。
 *  - 進階/跨機:把 bot 跑在另一台機器或 Docker(下方折疊區的引導 + .env 範本 + 連線資訊)。
 * 編輯採「草稿 + 儲存變更」模式(比照世界設定等分頁):改動先存本地 draft,按「確定修改」
 * 才一次 PUT;dirty 時顯示 sticky 底欄。狀態列(running/lastError)仍 5s 輪詢即時更新。
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
  { name: "/join", desc: "查看連線位址", admin: false },
  { name: "/version", desc: "查看版本與更新", admin: false },
  { name: "/top", desc: "等級排行榜", admin: false },
  { name: "/guilds", desc: "公會清單", admin: false },
  { name: "/boss", desc: "頭目重生狀態", admin: false },
  { name: "/broadcast", desc: "遊戲內廣播訊息", admin: true },
  { name: "/save", desc: "立即存檔", admin: true },
  { name: "/backup", desc: "立即備份", admin: true },
  { name: "/start", desc: "啟動伺服器", admin: true },
  { name: "/stop", desc: "停止伺服器", admin: true },
  { name: "/restart", desc: "重啟伺服器", admin: true },
  { name: "/update", desc: "更新伺服器", admin: true },
  { name: "/kick", desc: "踢出在線玩家", admin: true },
  { name: "/ban", desc: "封鎖玩家", admin: true },
  { name: "/unban", desc: "解除封鎖", admin: true },
  { name: "/rcon", desc: "執行 RCON 指令", admin: true },
];

const DEV_PORTAL = "https://discord.com/developers/applications";

/** 本地草稿:與 status.settings 同構,外加 token 的三態(undefined=不變 / 非空=更換 / ""=清除)。 */
interface Draft {
  enabled: boolean;
  adminUserIds: string[];
  notifyChannelId: string;
  notifyEvents: Set<WebhookEventType>;
  statusChannelId: string;
  token?: string;
}

function draftFromStatus(s: DiscordBotStatus): Draft {
  return {
    enabled: s.settings.enabled,
    adminUserIds: [...(s.settings.adminUserIds ?? [])],
    notifyChannelId: s.settings.notifyChannelId ?? "",
    notifyEvents: new Set((s.settings.notifyEvents ?? []) as WebhookEventType[]),
    statusChannelId: s.settings.statusChannelId ?? "",
  };
}

export function DiscordBotTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [addresses, setAddresses] = useState<{ ip: string; vpn: string | null }[]>([]);
  const [status, setStatus] = useState<DiscordBotStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tokenEditing, setTokenEditing] = useState(false);
  const [adminInput, setAdminInput] = useState("");
  const [saving, setSaving] = useState(false);
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

  // 同機狀態:掛載即拉一次,之後每 5s 輪詢(只更新 status 顯示;不動使用者的 draft)。
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

  // 首次載入(或重置後)以 status 初始化草稿;之後輪詢不覆蓋草稿。
  useEffect(() => {
    if (status && !draft) setDraft(draftFromStatus(status));
  }, [status, draft]);

  const tokenSet = !!status?.tokenSet;
  /** 儲存後會不會有 token(啟用開關的前提)。 */
  const willHaveToken = draft?.token !== undefined ? draft.token.length > 0 : tokenSet;

  const dirtyCount = useMemo(() => {
    if (!draft || !status) return 0;
    const s = status.settings;
    let n = 0;
    if (draft.enabled !== s.enabled) n++;
    if (draft.adminUserIds.join(",") !== (s.adminUserIds ?? []).join(",")) n++;
    if (draft.notifyChannelId.trim() !== (s.notifyChannelId ?? "")) n++;
    const ev = [...draft.notifyEvents].sort().join(",");
    if (ev !== [...(s.notifyEvents ?? [])].sort().join(",")) n++;
    if (draft.statusChannelId.trim() !== (s.statusChannelId ?? "")) n++;
    if (draft.token !== undefined) n++;
    return n;
  }, [draft, status]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setErr(null);
    try {
      const next = await client.setDiscordBot(instanceId, {
        enabled: draft.enabled,
        adminUserIds: draft.adminUserIds,
        notifyChannelId: draft.notifyChannelId.trim(),
        notifyEvents: [...draft.notifyEvents],
        statusChannelId: draft.statusChannelId.trim(),
        ...(draft.token !== undefined ? { token: draft.token } : {}),
      });
      setStatus(next);
      setDraft(draftFromStatus(next));
      setTokenEditing(false);
      setAdminInput("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (status) setDraft(draftFromStatus(status));
    setTokenEditing(false);
    setAdminInput("");
    setErr(null);
  };

  const addAdmin = () => {
    if (!draft) return;
    const id = adminInput.trim();
    setAdminInput("");
    if (!id || draft.adminUserIds.includes(id)) return;
    setDraft({ ...draft, adminUserIds: [...draft.adminUserIds, id] });
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

  if (!draft) return null;

  const enabled = draft.enabled;

  let statusText: string;
  let statusTone: string;
  if (!tokenSet) {
    statusText = t("尚未設定 token");
    statusTone = "text-ink-muted";
  } else if (!status?.settings.enabled) {
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
          {draft.token === "" ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="font-bold text-sun">{t("將在儲存後清除")}</span>
              <button
                type="button"
                className={btnGhost}
                onClick={() => setDraft({ ...draft, token: undefined })}
              >
                {t("復原")}
              </button>
            </div>
          ) : tokenSet && !tokenEditing && draft.token === undefined ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-1 font-bold text-grass">
                <FiCheck className="size-4" />
                {t("已設定")}
              </span>
              <button type="button" className={btnGhost} onClick={() => setTokenEditing(true)}>
                {t("更換")}
              </button>
              <button
                type="button"
                className={btnDanger}
                onClick={() => setDraft({ ...draft, token: "", enabled: false })}
              >
                {t("清除")}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft.token ?? ""}
                onChange={(e) => setDraft({ ...draft, token: e.target.value || undefined })}
                placeholder={t("貼上 bot token")}
                className={`${inputCls} min-w-0 flex-1`}
              />
              {tokenSet && (
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => {
                    setTokenEditing(false);
                    setDraft({ ...draft, token: undefined });
                  }}
                >
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
            disabled={!willHaveToken && !enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          {t("啟用")}
        </label>
        {!willHaveToken && <p className="mt-1 text-[11px] font-bold text-sun">{t("請先設定 token 再啟用。")}</p>}

        <div className="mt-3 text-sm">
          <span className="text-ink-muted">{t("狀態")}</span>
          <span className="text-ink-muted">:</span> <span className={`font-bold ${statusTone}`}>{statusText}</span>
        </div>
        {err && <p className="mt-1 text-[11px] font-bold text-berry">{err}</p>}
      </section>

      <section className={card}>
        <h4 className="text-sm font-extrabold">{t("管理員白名單")}</h4>
        <p className="mt-1 text-xs text-ink-muted">
          {t("只有清單中的 Discord 使用者能用管理指令(broadcast / restart / kick / ban / rcon);留空 = 沒有人能用。")}
        </p>
        <p className="mt-1 text-[11px] text-ink-muted">
          {t("取得 user id:Discord 設定 → 進階 → 開啟「開發者模式」,右鍵使用者 →「複製使用者 ID」。")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={adminInput}
            onChange={(e) => setAdminInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addAdmin();
              }
            }}
            placeholder={t("貼上 Discord user id")}
            inputMode="numeric"
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button type="button" className={btn} onClick={addAdmin} disabled={!adminInput.trim()}>
            {t("新增")}
          </button>
        </div>
        {draft.adminUserIds.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {draft.adminUserIds.map((id) => (
              <li
                key={id}
                className="flex items-center justify-between gap-2 rounded-lg border border-line bg-sky-soft px-3 py-1.5 text-sm"
              >
                <code className="font-mono text-xs text-ink">{id}</code>
                <button
                  type="button"
                  className="text-ink-muted transition hover:text-berry"
                  title={t("移除")}
                  onClick={() => setDraft({ ...draft, adminUserIds: draft.adminUserIds.filter((x) => x !== id) })}
                >
                  <FiX className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[11px] font-bold text-sun">{t("目前沒有任何管理員,管理指令沒有人能用。")}</p>
        )}
      </section>

      <section className={card}>
        <h4 className="text-sm font-extrabold">{t("事件通知")}</h4>
        <p className="mt-1 text-xs text-ink-muted">
          {t("讓 bot 把伺服器事件(玩家上下線、崩潰、頭目…)貼到指定頻道 —— 免另外設定 Webhook 網址。")}
        </p>
        <label className={`${labelCls} mt-3`}>
          <span>{t("通知頻道 ID")}</span>
          <input
            value={draft.notifyChannelId}
            onChange={(e) => setDraft({ ...draft, notifyChannelId: e.target.value })}
            placeholder={t("貼上頻道 ID(留空 = 不發通知)")}
            inputMode="numeric"
            className={inputCls}
          />
        </label>
        <p className="mt-1 text-[11px] text-ink-muted">
          {t("取得頻道 ID:開發者模式下右鍵頻道 →「複製頻道 ID」。請確認 bot 在該頻道有發言權限。")}
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs font-bold text-ink-muted">{t("要通知的事件")}</span>
          <EventPicker
            selected={draft.notifyEvents}
            onChange={(next) => setDraft({ ...draft, notifyEvents: next })}
          />
        </div>
      </section>

      <section className={card}>
        <h4 className="text-sm font-extrabold">{t("狀態面板")}</h4>
        <p className="mt-1 text-xs text-ink-muted">
          {t("讓 bot 在指定頻道維護一則「每分鐘自動更新」的伺服器狀態訊息(在線玩家、FPS、運行時間…),不會洗版。")}
        </p>
        <label className={`${labelCls} mt-3`}>
          <span>{t("狀態面板頻道 ID")}</span>
          <input
            value={draft.statusChannelId}
            onChange={(e) => setDraft({ ...draft, statusChannelId: e.target.value })}
            placeholder={t("貼上頻道 ID(留空 = 不顯示狀態面板)")}
            inputMode="numeric"
            className={inputCls}
          />
        </label>
        <p className="mt-1 text-[11px] text-ink-muted">
          {t("建議用獨立的 #status 頻道。bot 需要該頻道的發言與讀取訊息歷史權限;更改頻道後 bot 會自動重啟套用。")}
        </p>
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

      {dirtyCount > 0 && (
        <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-cute border-2 border-sun/50 bg-card p-3 shadow-(--shadow-cute)">
          <span className="text-[13px] font-bold text-ink-muted">
            {t("小心~您有 {n} 項變更尚未儲存!", { n: dirtyCount })}
          </span>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={reset} disabled={saving}>
              {t("重置")}
            </button>
            <button className={btn} onClick={() => void save()} disabled={saving}>
              {saving ? t("儲存中…") : t("確定修改")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
