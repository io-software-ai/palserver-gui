import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  FiCheckCircle,
  FiChevronDown,
  FiChevronUp,
  FiHash,
  FiLink,
  FiMessageCircle,
  FiPlus,
  FiRadio,
  FiSave,
  FiSend,
  FiShield,
  FiTrash2,
  FiX,
} from "react-icons/fi";
import { hasFeature, type MessageBridgeChannelConfig, type MessageBridgeChannelPatch, type MessageBridgeConfig, type MessageBridgeLanguage, type MessageBridgePatch, type MessageBridgePlatform, type MessageBridgeRules, type MessageBridgeStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { btn, btnGhost, card, errorCls, inputCls, labelCls, SponsorLockNotice } from "./ui";
import { getLang, t, useI18n } from "./i18n";

type DraftChannel =
  | (Extract<MessageBridgeChannelConfig, { platform: "onebot" }> & { accessToken: string })
  | (Extract<MessageBridgeChannelConfig, { platform: "discord" }> & { proxyUrl: string; token: string })
  | (Extract<MessageBridgeChannelConfig, { platform: "telegram" }> & { token: string })
  | (Extract<MessageBridgeChannelConfig, { platform: "webhook" }> & { secret: string });
type Draft = { channels: DraftChannel[] };
type Platform = MessageBridgePlatform;

const PLATFORMS: Array<{
  id: Platform;
  name: string;
  description: string;
  icon: ReactNode;
}> = [
  { id: "onebot", name: "OneBot 11 / QQ", description: "NapCat、Lagrange 等 OneBot 實作", icon: <FiRadio /> },
  { id: "discord", name: "Discord", description: "Discord Bot + 文字頻道", icon: <FiHash /> },
  { id: "telegram", name: "Telegram", description: "Telegram Bot + 群組", icon: <FiSend /> },
  { id: "webhook", name: "通用 Webhook", description: "飛書、企業微信或自建中轉", icon: <FiLink /> },
];

const toDraft = (config: MessageBridgeConfig): Draft => ({ channels: config.channels.map((channel): DraftChannel => {
  if (channel.platform === "onebot") return { ...channel, accessToken: "" };
  if (channel.platform === "discord") return { ...channel, proxyUrl: "", token: "" };
  if (channel.platform === "telegram") return { ...channel, token: "" };
  return { ...channel, secret: "" };
}) });

/** GUI 目前語言 → 頻道預設訊息語言("zh" 對應 "zh-TW",其餘同名)。 */
const guiLanguage = (): MessageBridgeLanguage => {
  const lang = getLang();
  return lang === "zh" ? "zh-TW" : lang;
};

const newChannel = (platform: Platform): DraftChannel => {
  const id = `${platform}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const common = { ...rulePatch({ relayGroupToGame: true, relayGameToGroup: true, notifyJoinLeave: true, notifyCapture: true, notifyDeath: true, notifyBoss: true, notifyServerStatus: true, notifyBackup: true, relayPrefix: "", commandPrefix: "/" }), id, enabled: true, adminIds: [], language: guiLanguage() };
  if (platform === "onebot") return { ...common, platform, wsUrl: "ws://127.0.0.1:3001", groupId: "", accessTokenSet: false, accessToken: "" };
  if (platform === "discord") return { ...common, platform, channelId: "", proxyEnabled: false, proxyUrlSet: false, tokenSet: false, proxyUrl: "", token: "" };
  if (platform === "telegram") return { ...common, platform, chatId: "", tokenSet: false, token: "" };
  return { ...common, platform, url: "", secretSet: false, secret: "" };
};

const rulePatch = (channel: MessageBridgeRules): MessageBridgeRules => ({
  relayGroupToGame: channel.relayGroupToGame,
  relayGameToGroup: channel.relayGameToGroup,
  notifyJoinLeave: channel.notifyJoinLeave,
  notifyCapture: channel.notifyCapture,
  notifyDeath: channel.notifyDeath,
  notifyBoss: channel.notifyBoss,
  notifyServerStatus: channel.notifyServerStatus,
  notifyBackup: channel.notifyBackup,
  relayPrefix: channel.relayPrefix,
  commandPrefix: channel.commandPrefix,
});

export function MessageBridgeTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<MessageBridgeStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [entitled, setEntitled] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (initial: boolean) => {
      try {
        const result = await client.messageBridge(instanceId);
        if (!alive) return;
        if (initial) setDraft(toDraft(result.config));
        setStatus(result.status);
      } catch (err) {
        if (alive && initial) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load(true);
    const timer = setInterval(() => void load(false), 5_000);
    return () => { alive = false; clearInterval(timer); };
  }, [client, instanceId]);

  // 授權:Webhook(群服互通)為贊助者先行版
  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("message-bridge", l)))
      .catch(() => setEntitled(false));
  }, [client, instanceId]);

  const platformCounts = useMemo(() => new Map(PLATFORMS.map((platform) => [platform.id, draft?.channels.filter((channel) => channel.platform === platform.id).length ?? 0])), [draft]);

  // 贊助者限定:未解鎖只顯示先行版說明,不顯示表單。
  if (entitled === false) {
    return (
      <div className="flex flex-col gap-4">
        <SponsorLockNotice>{t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}</SponsorLockNotice>
      </div>
    );
  }

  if (!draft) {
    return <div className="max-w-3xl">{error ? <p className={errorCls}>{error}</p> : <p className="text-sm text-ink-muted">{t("載入中…")}</p>}</div>;
  }

  const setChannel = (channelId: string, patch: Partial<DraftChannel>) => {
    setDraft({ channels: draft.channels.map((channel) => channel.id === channelId ? { ...channel, ...patch } as DraftChannel : channel) });
    setError(null);
    setNotice(null);
  };
  const addPlatform = (platform: Platform) => {
    const channel = newChannel(platform);
    setDraft({ channels: [...draft.channels, channel] });
    setExpanded(channel.id);
    setAdding(false);
  };
  const removeChannel = (channelId: string) => {
    setDraft({ channels: draft.channels.filter((channel) => channel.id !== channelId) });
    if (expanded === channelId) setExpanded(null);
    setNotice(t("頻道已標記移除，儲存後生效。"));
  };

  const isReady = (channel: DraftChannel): boolean => {
    if (!channel.enabled) return true;
    if (channel.platform === "onebot") return !!channel.wsUrl.trim() && !!channel.groupId.trim();
    if (channel.platform === "discord") return !!channel.channelId.trim()
      && (channel.tokenSet || !!channel.token.trim())
      && (!channel.proxyEnabled || channel.proxyUrlSet || !!channel.proxyUrl.trim());
    if (channel.platform === "telegram") return !!channel.chatId.trim() && (channel.tokenSet || !!channel.token.trim());
    return !!channel.url.trim() && (channel.secretSet || !!channel.secret.trim());
  };

  const toPatch = (channel: DraftChannel): MessageBridgeChannelPatch => {
    const common = { ...rulePatch(channel), id: channel.id, platform: channel.platform, enabled: channel.enabled, adminIds: channel.adminIds, language: channel.language };
    if (channel.platform === "onebot") return { ...common, platform: channel.platform, wsUrl: channel.wsUrl, groupId: channel.groupId, accessToken: channel.accessToken };
    if (channel.platform === "discord") return { ...common, platform: channel.platform, channelId: channel.channelId, proxyEnabled: channel.proxyEnabled, proxyUrl: channel.proxyUrl, token: channel.token };
    if (channel.platform === "telegram") return { ...common, platform: channel.platform, chatId: channel.chatId, token: channel.token };
    return { ...common, platform: channel.platform, url: channel.url, secret: channel.secret };
  };

  const save = async () => {
    const invalid = draft.channels.find((channel) => !isReady(channel));
    if (invalid) {
      setExpanded(invalid.id);
      setError(t("請完整填寫已啟用頻道的連線資訊。"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const patch: MessageBridgePatch = { channels: draft.channels.map(toPatch) };
    try {
      const result = await client.updateMessageBridge(instanceId, patch);
      setDraft(toDraft(result.config));
      setStatus(result.status);
      setNotice(t("已儲存"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><FiMessageCircle className="text-pal" /> {t("Webhook")}</h2>
          <p className="mt-1 text-[13px] text-ink-muted">{t("連線群組與遊戲伺服器，並在多個訊息平台之間同步聊天和事件。")}</p>
        </div>
        <button className={`${btn} inline-flex items-center gap-1.5`} disabled={busy || draft.channels.some((channel) => !channel.commandPrefix)} onClick={() => void save()}>
          <FiSave className="size-4" /> {busy ? t("儲存中…") : t("儲存變更")}
        </button>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold">{t("訊息頻道")}</h3>
            <p className="mt-1 text-xs text-ink-muted">{t("每種頻道可新增多個獨立連線。")}</p>
          </div>
          <button className={`${btnGhost} inline-flex items-center gap-1.5`} disabled={draft.channels.length >= 32} onClick={() => setAdding(true)}>
            <FiPlus className="size-4" /> {t("新增頻道")}
          </button>
        </div>

        {draft.channels.length === 0 ? (
          <button className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line bg-card-soft px-4 text-center transition hover:border-pal" onClick={() => setAdding(true)}>
            <FiPlus className="size-5 text-pal" />
            <span className="text-sm font-extrabold">{t("新增第一個訊息頻道")}</span>
            <span className="text-xs text-ink-muted">OneBot、Discord、Telegram、Webhook</span>
          </button>
        ) : draft.channels.map((channel, index) => {
          const meta = PLATFORMS.find((candidate) => candidate.id === channel.platform)!;
          const ordinal = draft.channels.slice(0, index + 1).filter((candidate) => candidate.platform === channel.platform).length;
          const duplicate = (platformCounts.get(channel.platform) ?? 0) > 1;
          const open = expanded === channel.id;
          const state = status?.channels[channel.id];
          return (
            <article key={channel.id} className={card}>
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-card-soft text-pal">{meta.icon}</span>
                <button className="min-w-0 flex-1 text-left" onClick={() => setExpanded(open ? null : channel.id)}>
                  <span className="block text-sm font-extrabold">{t(meta.name)}{duplicate ? ` #${ordinal}` : ""}</span>
                  <ChannelStatus channelEnabled={channel.enabled} connected={state?.connected ?? false} error={state?.error ?? null} />
                </button>
                <Toggle checked={channel.enabled} onChange={(enabled) => setChannel(channel.id, { enabled })} label={channel.enabled ? t("啟用") : t("停用")} compact />
                <button className="grid size-8 shrink-0 place-items-center text-ink-muted transition hover:text-danger" onClick={() => removeChannel(channel.id)} title={t("移除頻道")} aria-label={t("移除頻道")}><FiTrash2 /></button>
                <button className="grid size-8 shrink-0 place-items-center text-ink-muted" onClick={() => setExpanded(open ? null : channel.id)} aria-label={open ? t("收起") : t("編輯")}>{open ? <FiChevronUp /> : <FiChevronDown />}</button>
              </div>
              {open && <div className="mt-4 border-t-2 border-line pt-4"><ChannelForm channel={channel} client={client} instanceId={instanceId} onChange={(patch) => setChannel(channel.id, patch)} /></div>}
            </article>
          );
        })}
      </section>

      {error && <p className={errorCls}>{error}</p>}
      {notice && <p className="inline-flex items-center gap-1.5 text-xs font-bold text-ok"><FiCheckCircle /> {notice}</p>}

      {adding && <AddChannelDialog onAdd={addPlatform} onClose={() => setAdding(false)} />}
    </div>
  );
}

function ChannelForm({ channel, client, instanceId, onChange }: {
  channel: DraftChannel;
  client: AgentClient;
  instanceId: string;
  onChange: (patch: Partial<DraftChannel>) => void;
}) {
  if (channel.platform === "onebot") return <div className="grid gap-3 sm:grid-cols-2">
    <ChannelRulesForm value={channel} onChange={onChange} />
    <LanguageField value={channel.language} onChange={(language) => onChange({ language })} />
    <Field label="WebSocket URL"><input className={inputCls} value={channel.wsUrl} onChange={(e) => onChange({ wsUrl: e.target.value })} placeholder="ws://127.0.0.1:3001" /></Field>
    <Field label={t("群號")}><input className={inputCls} value={channel.groupId} onChange={(e) => onChange({ groupId: e.target.value })} /></Field>
    <SecretField label="Access Token" value={channel.accessToken} saved={channel.accessTokenSet} onChange={(accessToken) => onChange({ accessToken })} />
    <p className="self-end text-xs text-ink-muted">{t("在 OneBot 實作中開啟正向 WebSocket，並填寫監聽地址、群號和存取權杖。")}</p>
    <AdminField value={channel.adminIds} onChange={(adminIds) => onChange({ adminIds })} />
  </div>;
  if (channel.platform === "discord") return <div className="grid gap-3 sm:grid-cols-2">
    <ChannelRulesForm value={channel} onChange={onChange} />
    <LanguageField value={channel.language} onChange={(language) => onChange({ language })} />
    <Field label="Channel ID"><input className={inputCls} value={channel.channelId} onChange={(e) => onChange({ channelId: e.target.value })} /></Field>
    <SecretField label="Bot Token" value={channel.token} saved={channel.tokenSet} onChange={(token) => onChange({ token })} />
    <p className="text-xs text-ink-muted sm:col-span-2">{t("在 Discord Developer Portal 啟用 Message Content Intent，並授予機器人查看頻道與發送訊息權限。")}</p>
    <div className="flex flex-col gap-3 border-y-2 border-line py-3 sm:col-span-2">
      <Check checked={channel.proxyEnabled} onChange={(proxyEnabled) => onChange({ proxyEnabled })} label={t("使用代理連線 Discord")} />
      {channel.proxyEnabled && <div className="grid gap-3 sm:grid-cols-2">
        <SecretField label={t("代理地址")} value={channel.proxyUrl} saved={channel.proxyUrlSet} onChange={(proxyUrl) => onChange({ proxyUrl })} />
        <p className="self-end text-xs text-ink-muted">{t("同時用於 Discord Gateway 和訊息 API。支援 HTTP、HTTPS、SOCKS4、SOCKS5，例如 http://127.0.0.1:7890。")}</p>
      </div>}
      <p className="text-xs text-ink-muted">{t("如果狀態持續顯示「Discord Gateway 已斷開」，請啟用代理並確認本機代理軟體允許 Agent 存取。")}</p>
    </div>
    <AdminField value={channel.adminIds} onChange={(adminIds) => onChange({ adminIds })} />
  </div>;
  if (channel.platform === "telegram") return <div className="grid gap-3 sm:grid-cols-2">
    <ChannelRulesForm value={channel} onChange={onChange} />
    <LanguageField value={channel.language} onChange={(language) => onChange({ language })} />
    <Field label="Chat ID"><input className={inputCls} value={channel.chatId} onChange={(e) => onChange({ chatId: e.target.value })} placeholder="-100..." /></Field>
    <SecretField label="Bot Token" value={channel.token} saved={channel.tokenSet} onChange={(token) => onChange({ token })} />
    <p className="text-xs text-ink-muted sm:col-span-2">{t("將機器人加入群組，關閉隱私模式後填寫 Bot Token 和 Chat ID。")}</p>
    <AdminField value={channel.adminIds} onChange={(adminIds) => onChange({ adminIds })} />
  </div>;
  return <div className="grid gap-3 sm:grid-cols-2">
    <ChannelRulesForm value={channel} onChange={onChange} />
    <LanguageField value={channel.language} onChange={(language) => onChange({ language })} />
    <Field label={t("出站 URL")}><input className={inputCls} value={channel.url} onChange={(e) => onChange({ url: e.target.value })} placeholder="https://..." /></Field>
    <SecretField label={t("共享密鑰")} value={channel.secret} saved={channel.secretSet} onChange={(secret) => onChange({ secret })} />
    <AdminField value={channel.adminIds} onChange={(adminIds) => onChange({ adminIds })} />
    <div className="text-xs text-ink-muted sm:col-span-2">
      <p className="break-all"><FiLink className="mr-1 inline size-3.5" />POST {client.messageBridgeWebhookUrl(instanceId, channel.id)}</p>
      <p className="mt-1 break-all font-mono">X-Palserver-Secret: *** {`{"userId":"stable-id","author":"name","text":"message"}`}</p>
    </div>
  </div>;
}

function AddChannelDialog({ onAdd, onClose }: { onAdd: (platform: Platform) => void; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-label={t("新增訊息頻道")} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="w-full max-w-md rounded-lg border-2 border-line bg-card p-5 shadow-xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><h3 className="text-base font-extrabold">{t("新增訊息頻道")}</h3><p className="mt-1 text-xs text-ink-muted">{t("選擇連線方式，新增後再填寫連線資訊。")}</p></div>
        <button className="grid size-8 place-items-center text-ink-muted" onClick={onClose} aria-label={t("關閉")}><FiX /></button>
      </div>
      <div className="flex flex-col gap-2">
        {PLATFORMS.map((platform) => <button key={platform.id} className="flex items-center gap-3 rounded-lg border-2 border-line px-3 py-3 text-left transition hover:border-pal hover:bg-card-soft" onClick={() => onAdd(platform.id)}>
          <span className="grid size-9 shrink-0 place-items-center text-pal">{platform.icon}</span>
          <span><strong className="block text-sm">{t(platform.name)}</strong><span className="text-xs text-ink-muted">{t(platform.description)}</span></span>
          <FiPlus className="ml-auto shrink-0 text-ink-muted" />
        </button>)}
      </div>
    </div>
  </div>;
}

function ChannelStatus({ channelEnabled, connected, error }: { channelEnabled: boolean; connected: boolean; error: string | null }) {
  const label = !channelEnabled ? t("頻道已停用") : connected ? t("已連接") : error || t("等待連接");
  const color = channelEnabled && connected ? "bg-ok" : error && channelEnabled ? "bg-danger" : "bg-ink-muted";
  return <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-muted"><span className={`size-1.5 shrink-0 rounded-full ${color}`} /><span className="truncate" title={error ?? undefined}>{label}</span></span>;
}

function ChannelRulesForm({ value, onChange }: { value: MessageBridgeRules; onChange: (patch: Partial<MessageBridgeRules>) => void }) {
  return <section className="flex flex-col gap-3 border-b-2 border-line pb-4 sm:col-span-2">
    <h4 className="text-sm font-extrabold">{t("互通規則")}</h4>
    <div className="grid gap-2 sm:grid-cols-2">
      <Check checked={value.relayGroupToGame} onChange={(relayGroupToGame) => onChange({ relayGroupToGame })} label={t("群訊息轉發到遊戲")} />
      <Check checked={value.relayGameToGroup} onChange={(relayGameToGroup) => onChange({ relayGameToGroup })} label={t("遊戲聊天轉發到群")} />
      <Check checked={value.notifyJoinLeave} onChange={(notifyJoinLeave) => onChange({ notifyJoinLeave })} label={t("玩家進出提示")} />
      <Check checked={value.notifyCapture} onChange={(notifyCapture) => onChange({ notifyCapture })} label={t("抓捕帕魯提示")} />
      <Check checked={value.notifyDeath} onChange={(notifyDeath) => onChange({ notifyDeath })} label={t("玩家死亡提示")} />
      <Check checked={value.notifyBoss} onChange={(notifyBoss) => onChange({ notifyBoss })} label={t("頭目擊殺/重生提示")} />
      <Check checked={value.notifyServerStatus} onChange={(notifyServerStatus) => onChange({ notifyServerStatus })} label={t("伺服器狀態提示")} />
      <Check checked={value.notifyBackup} onChange={(notifyBackup) => onChange({ notifyBackup })} label={t("備份完成提示")} />
      <label className="flex items-center gap-2 text-[13px] font-bold">
        {t("訊息轉發前綴")}
        <input className={`${inputCls} w-24 py-1.5`} value={value.relayPrefix} maxLength={20} placeholder={t("留空時全部轉發")} onChange={(event) => onChange({ relayPrefix: event.target.value })} />
      </label>
      <label className="flex items-center gap-2 text-[13px] font-bold">
        {t("指令前綴")}
        <input className={`${inputCls} w-16 py-1.5`} value={value.commandPrefix} maxLength={3} onChange={(event) => onChange({ commandPrefix: event.target.value })} />
      </label>
    </div>
    <p className="text-xs text-ink-muted">{t("設定訊息轉發前綴後，只有帶此前綴的群訊息會被轉發，轉發時會移除前綴；留空則轉發全部群訊息。")}</p>
    <p className="text-xs text-ink-muted">{t("群內可使用 /server、/players、/help、/whoami；管理員可使用 /adminhelp 查看管理指令。群訊息也會同步到其他已連接平台。死亡與抓捕事件需要 PalDefender 日誌。")}</p>
  </section>;
}

function Toggle({ checked, onChange, label, compact = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; compact?: boolean }) {
  return <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-xs font-bold">
    {!compact && <span>{label}</span>}
    <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    <span className="relative h-6 w-11 rounded-full bg-line transition peer-checked:bg-pal after:absolute after:left-1 after:top-1 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5" />
  </label>;
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <label className="inline-flex items-center gap-2 text-[13px] font-bold"><input type="checkbox" className="size-4 accent-pal" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={labelCls}><span>{label}</span>{children}</label>;
}

function LanguageField({ value, onChange }: { value: MessageBridgeLanguage; onChange: (value: MessageBridgeLanguage) => void }) {
  return <Field label={t("訊息語言")}><select className={inputCls} value={value} onChange={(event) => onChange(event.target.value as MessageBridgeLanguage)}>
    <option value="zh-TW">繁體中文</option>
    <option value="zh-CN">简体中文</option>
    <option value="en">English</option>
    <option value="ja">日本語</option>
  </select></Field>;
}

function SecretField({ label, value, saved, onChange }: { label: string; value: string; saved: boolean; onChange: (value: string) => void }) {
  return <Field label={label}><input className={inputCls} type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={saved ? t("已儲存；留空則不修改") : t("尚未配置")} /></Field>;
}

function AdminField({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const rows = value.length > 0 ? value : [""];
  const update = (index: number, id: string) => onChange(rows.map((row, rowIndex) => rowIndex === index ? id : row));
  const remove = (index: number) => onChange(rows.length === 1 ? [] : rows.filter((_, rowIndex) => rowIndex !== index));
  return <fieldset className={`${labelCls} sm:col-span-2`}>
    <legend className="inline-flex items-center gap-1.5"><FiShield className="text-pal" />{t("頻道管理員用戶 ID")}</legend>
    <div className="flex flex-col gap-2">
      {rows.map((id, index) => <div key={index} className="flex items-center gap-2">
        <input
          className={`${inputCls} min-w-0 flex-1 font-mono text-xs`}
          value={id}
          onChange={(event) => update(index, event.target.value)}
          placeholder={t("群內發送 /whoami 可查詢用戶 ID")}
          aria-label={`${t("頻道管理員用戶 ID")} ${index + 1}`}
        />
        <button
          type="button"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-muted transition hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
          disabled={rows.length === 1 && !id}
          onClick={() => remove(index)}
          title={t("移除管理員")}
          aria-label={t("移除管理員")}
        ><FiTrash2 /></button>
      </div>)}
      <button
        type="button"
        className="grid size-9 place-items-center rounded-lg border-2 border-dashed border-line text-pal transition hover:border-pal hover:bg-card-soft disabled:cursor-not-allowed disabled:opacity-40"
        disabled={rows.length >= 50}
        onClick={() => onChange([...rows, ""])}
        title={t("新增管理員")}
        aria-label={t("新增管理員")}
      ><FiPlus /></button>
    </div>
  </fieldset>;
}
