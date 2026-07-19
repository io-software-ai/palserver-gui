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
import type { MessageBridgeConfig, MessageBridgePatch, MessageBridgePlatform, MessageBridgeStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { btn, btnGhost, card, errorCls, inputCls, labelCls } from "./ui";
import { t, useI18n } from "./i18n";

type Draft = MessageBridgeConfig & {
  onebot: MessageBridgeConfig["onebot"] & { accessToken: string };
  discord: MessageBridgeConfig["discord"] & { token: string };
  telegram: MessageBridgeConfig["telegram"] & { token: string };
  webhook: MessageBridgeConfig["webhook"] & { secret: string };
};

type Platform = keyof Pick<Draft, "onebot" | "discord" | "telegram" | "webhook">;

const PLATFORMS: Array<{
  id: Platform;
  name: string;
  description: string;
  icon: ReactNode;
}> = [
  { id: "onebot", name: "OneBot 11 / QQ", description: "NapCat、Lagrange 等 OneBot 实现", icon: <FiRadio /> },
  { id: "discord", name: "Discord", description: "Discord Bot + 文字频道", icon: <FiHash /> },
  { id: "telegram", name: "Telegram", description: "Telegram Bot + 群组", icon: <FiSend /> },
  { id: "webhook", name: "通用 Webhook", description: "飞书、企业微信或自建中转", icon: <FiLink /> },
];

const toDraft = (config: MessageBridgeConfig): Draft => ({
  ...config,
  onebot: { ...config.onebot, accessToken: "" },
  discord: { ...config.discord, token: "" },
  telegram: { ...config.telegram, token: "" },
  webhook: { ...config.webhook, secret: "" },
});

export function MessageBridgeTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<MessageBridgeStatus | null>(null);
  const [expanded, setExpanded] = useState<Platform | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  const added = useMemo(() => PLATFORMS.filter((p) => draft?.[p.id].added), [draft]);
  const available = useMemo(() => PLATFORMS.filter((p) => !draft?.[p.id].added), [draft]);

  if (!draft) {
    return <div className="max-w-3xl">{error ? <p className={errorCls}>{error}</p> : <p className="text-sm text-ink-muted">{t("載入中…")}</p>}</div>;
  }

  const setTop = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft({ ...draft, [key]: value });
    setError(null);
    setNotice(null);
  };
  const setPlatform = <P extends Platform>(platform: P, patch: Partial<Draft[P]>) => {
    setDraft({ ...draft, [platform]: { ...draft[platform], ...patch } });
    setError(null);
    setNotice(null);
  };
  const addPlatform = (platform: Platform) => {
    setPlatform(platform, { added: true, enabled: true });
    setExpanded(platform);
    setAdding(false);
  };
  const removePlatform = (platform: Platform) => {
    setPlatform(platform, { added: false, enabled: false });
    if (expanded === platform) setExpanded(null);
    setNotice(t("渠道已标记移除，保存后生效。"));
  };

  const isReady = (platform: Platform): boolean => {
    if (!draft[platform].enabled) return true;
    if (platform === "onebot") return !!draft.onebot.wsUrl.trim() && !!draft.onebot.groupId.trim();
    if (platform === "discord") return !!draft.discord.channelId.trim() && (draft.discord.tokenSet || !!draft.discord.token.trim());
    if (platform === "telegram") return !!draft.telegram.chatId.trim() && (draft.telegram.tokenSet || !!draft.telegram.token.trim());
    return !!draft.webhook.url.trim() && (draft.webhook.secretSet || !!draft.webhook.secret.trim());
  };

  const save = async () => {
    const invalid = added.find((p) => !isReady(p.id));
    if (invalid) {
      setExpanded(invalid.id);
      setError(t("请完整填写已启用渠道的连接信息。"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const patch: MessageBridgePatch = {
      enabled: draft.enabled,
      relayGroupToGame: draft.relayGroupToGame,
      relayGameToGroup: draft.relayGameToGroup,
      notifyJoinLeave: draft.notifyJoinLeave,
      notifyCapture: draft.notifyCapture,
      notifyDeath: draft.notifyDeath,
      commandPrefix: draft.commandPrefix,
      onebot: { added: draft.onebot.added, enabled: draft.onebot.enabled, wsUrl: draft.onebot.wsUrl, groupId: draft.onebot.groupId, adminIds: draft.onebot.adminIds, language: draft.onebot.language, accessToken: draft.onebot.accessToken },
      discord: { added: draft.discord.added, enabled: draft.discord.enabled, channelId: draft.discord.channelId, adminIds: draft.discord.adminIds, language: draft.discord.language, token: draft.discord.token },
      telegram: { added: draft.telegram.added, enabled: draft.telegram.enabled, chatId: draft.telegram.chatId, adminIds: draft.telegram.adminIds, language: draft.telegram.language, token: draft.telegram.token },
      webhook: { added: draft.webhook.added, enabled: draft.webhook.enabled, url: draft.webhook.url, adminIds: draft.webhook.adminIds, language: draft.webhook.language, secret: draft.webhook.secret },
    };
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
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><FiMessageCircle className="text-pal" /> {t("群服互通")}</h2>
          <p className="mt-1 text-[13px] text-ink-muted">{t("连接群聊与游戏服务器，并在多个消息平台之间同步聊天和事件。")}</p>
        </div>
        <button className={`${btn} inline-flex items-center gap-1.5`} disabled={busy || !draft.commandPrefix} onClick={() => void save()}>
          <FiSave className="size-4" /> {busy ? t("儲存中…") : t("儲存變更")}
        </button>
      </div>

      <section className={`${card} flex flex-col gap-4`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold">{t("互通规则")}</h3>
            <p className="mt-1 text-xs text-ink-muted">{t("总开关关闭时保留所有渠道配置，但停止收发消息。")}</p>
          </div>
          <Toggle checked={draft.enabled} onChange={(enabled) => setTop("enabled", enabled)} label={draft.enabled ? t("运行中") : t("已暂停")} />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Check checked={draft.relayGroupToGame} onChange={(v) => setTop("relayGroupToGame", v)} label={t("群消息轉發到遊戲")} />
          <Check checked={draft.relayGameToGroup} onChange={(v) => setTop("relayGameToGroup", v)} label={t("遊戲聊天轉發到群")} />
          <Check checked={draft.notifyJoinLeave} onChange={(v) => setTop("notifyJoinLeave", v)} label={t("玩家進出提示")} />
          <Check checked={draft.notifyCapture} onChange={(v) => setTop("notifyCapture", v)} label={t("抓捕帕魯提示")} />
          <Check checked={draft.notifyDeath} onChange={(v) => setTop("notifyDeath", v)} label={t("玩家死亡提示")} />
          <label className="flex items-center gap-2 text-[13px] font-bold">
            {t("指令前綴")}
            <input className={`${inputCls} w-16 py-1.5`} value={draft.commandPrefix} maxLength={3} onChange={(e) => setTop("commandPrefix", e.target.value)} />
          </label>
        </div>
        <p className="text-xs text-ink-muted">{t("群內可使用 /server、/players、/help、/whoami；管理員可使用 /adminhelp 查看管理指令。群消息也會同步到其他已連接平台。死亡與抓捕事件需要 PalDefender 日誌。")}</p>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold">{t("消息渠道")}</h3>
            <p className="mt-1 text-xs text-ink-muted">{t("每种渠道可添加一个连接。")}</p>
          </div>
          <button className={`${btnGhost} inline-flex items-center gap-1.5`} disabled={available.length === 0} onClick={() => setAdding(true)}>
            <FiPlus className="size-4" /> {t("添加渠道")}
          </button>
        </div>

        {added.length === 0 ? (
          <button className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line bg-card-soft px-4 text-center transition hover:border-pal" onClick={() => setAdding(true)}>
            <FiPlus className="size-5 text-pal" />
            <span className="text-sm font-extrabold">{t("添加第一个消息渠道")}</span>
            <span className="text-xs text-ink-muted">OneBot、Discord、Telegram、Webhook</span>
          </button>
        ) : added.map((meta) => {
          const platform = meta.id;
          const channel = draft[platform];
          const open = expanded === platform;
          const state = status?.platforms[platform];
          return (
            <article key={platform} className={card}>
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-card-soft text-pal">{meta.icon}</span>
                <button className="min-w-0 flex-1 text-left" onClick={() => setExpanded(open ? null : platform)}>
                  <span className="block text-sm font-extrabold">{t(meta.name)}</span>
                  <ChannelStatus globalEnabled={draft.enabled} channelEnabled={channel.enabled} connected={state?.connected ?? false} error={state?.error ?? null} />
                </button>
                <Toggle checked={channel.enabled} onChange={(enabled) => setPlatform(platform, { enabled })} label={channel.enabled ? t("啟用") : t("停用")} compact />
                <button className="grid size-8 shrink-0 place-items-center text-ink-muted transition hover:text-danger" onClick={() => removePlatform(platform)} title={t("移除渠道")} aria-label={t("移除渠道")}><FiTrash2 /></button>
                <button className="grid size-8 shrink-0 place-items-center text-ink-muted" onClick={() => setExpanded(open ? null : platform)} aria-label={open ? t("收起") : t("編輯")}>{open ? <FiChevronUp /> : <FiChevronDown />}</button>
              </div>
              {open && <div className="mt-4 border-t-2 border-line pt-4"><ChannelForm platform={platform} draft={draft} client={client} instanceId={instanceId} setPlatform={setPlatform} /></div>}
            </article>
          );
        })}
      </section>

      {error && <p className={errorCls}>{error}</p>}
      {notice && <p className="inline-flex items-center gap-1.5 text-xs font-bold text-ok"><FiCheckCircle /> {notice}</p>}

      {adding && <AddChannelDialog available={available} onAdd={addPlatform} onClose={() => setAdding(false)} />}
    </div>
  );
}

function ChannelForm({ platform, draft, client, instanceId, setPlatform }: {
  platform: Platform;
  draft: Draft;
  client: AgentClient;
  instanceId: string;
  setPlatform: <P extends Platform>(platform: P, patch: Partial<Draft[P]>) => void;
}) {
  if (platform === "onebot") return <div className="grid gap-3 sm:grid-cols-2">
    <LanguageField value={draft.onebot.language} onChange={(language) => setPlatform("onebot", { language })} />
    <Field label="WebSocket URL"><input className={inputCls} value={draft.onebot.wsUrl} onChange={(e) => setPlatform("onebot", { wsUrl: e.target.value })} placeholder="ws://127.0.0.1:3001" /></Field>
    <Field label={t("群號")}><input className={inputCls} value={draft.onebot.groupId} onChange={(e) => setPlatform("onebot", { groupId: e.target.value })} /></Field>
    <SecretField label="Access Token" value={draft.onebot.accessToken} saved={draft.onebot.accessTokenSet} onChange={(accessToken) => setPlatform("onebot", { accessToken })} />
    <p className="self-end text-xs text-ink-muted">{t("在 OneBot 实现中开启正向 WebSocket，并填写监听地址、群号和访问令牌。")}</p>
    <AdminField value={draft.onebot.adminIds} onChange={(adminIds) => setPlatform("onebot", { adminIds })} />
  </div>;
  if (platform === "discord") return <div className="grid gap-3 sm:grid-cols-2">
    <LanguageField value={draft.discord.language} onChange={(language) => setPlatform("discord", { language })} />
    <Field label="Channel ID"><input className={inputCls} value={draft.discord.channelId} onChange={(e) => setPlatform("discord", { channelId: e.target.value })} /></Field>
    <SecretField label="Bot Token" value={draft.discord.token} saved={draft.discord.tokenSet} onChange={(token) => setPlatform("discord", { token })} />
    <p className="text-xs text-ink-muted sm:col-span-2">{t("在 Discord Developer Portal 啟用 Message Content Intent，並授予機器人查看頻道與發送消息權限。")}</p>
    <AdminField value={draft.discord.adminIds} onChange={(adminIds) => setPlatform("discord", { adminIds })} />
  </div>;
  if (platform === "telegram") return <div className="grid gap-3 sm:grid-cols-2">
    <LanguageField value={draft.telegram.language} onChange={(language) => setPlatform("telegram", { language })} />
    <Field label="Chat ID"><input className={inputCls} value={draft.telegram.chatId} onChange={(e) => setPlatform("telegram", { chatId: e.target.value })} placeholder="-100..." /></Field>
    <SecretField label="Bot Token" value={draft.telegram.token} saved={draft.telegram.tokenSet} onChange={(token) => setPlatform("telegram", { token })} />
    <p className="text-xs text-ink-muted sm:col-span-2">{t("将机器人加入群组，关闭隐私模式后填写 Bot Token 和 Chat ID。")}</p>
    <AdminField value={draft.telegram.adminIds} onChange={(adminIds) => setPlatform("telegram", { adminIds })} />
  </div>;
  return <div className="grid gap-3 sm:grid-cols-2">
    <LanguageField value={draft.webhook.language} onChange={(language) => setPlatform("webhook", { language })} />
    <Field label={t("出站 URL")}><input className={inputCls} value={draft.webhook.url} onChange={(e) => setPlatform("webhook", { url: e.target.value })} placeholder="https://..." /></Field>
    <SecretField label={t("共享密鑰")} value={draft.webhook.secret} saved={draft.webhook.secretSet} onChange={(secret) => setPlatform("webhook", { secret })} />
    <AdminField value={draft.webhook.adminIds} onChange={(adminIds) => setPlatform("webhook", { adminIds })} />
    <div className="text-xs text-ink-muted sm:col-span-2">
      <p className="break-all"><FiLink className="mr-1 inline size-3.5" />POST {client.messageBridgeWebhookUrl(instanceId)}</p>
      <p className="mt-1 break-all font-mono">X-Palserver-Secret: *** {`{"userId":"stable-id","author":"name","text":"message"}`}</p>
    </div>
  </div>;
}

function AddChannelDialog({ available, onAdd, onClose }: { available: typeof PLATFORMS; onAdd: (platform: Platform) => void; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-label={t("添加消息渠道")} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="w-full max-w-md rounded-lg border-2 border-line bg-card p-5 shadow-xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><h3 className="text-base font-extrabold">{t("添加消息渠道")}</h3><p className="mt-1 text-xs text-ink-muted">{t("选择连接方式，添加后再填写连接信息。")}</p></div>
        <button className="grid size-8 place-items-center text-ink-muted" onClick={onClose} aria-label={t("關閉")}><FiX /></button>
      </div>
      <div className="flex flex-col gap-2">
        {available.map((platform) => <button key={platform.id} className="flex items-center gap-3 rounded-lg border-2 border-line px-3 py-3 text-left transition hover:border-pal hover:bg-card-soft" onClick={() => onAdd(platform.id)}>
          <span className="grid size-9 shrink-0 place-items-center text-pal">{platform.icon}</span>
          <span><strong className="block text-sm">{t(platform.name)}</strong><span className="text-xs text-ink-muted">{t(platform.description)}</span></span>
          <FiPlus className="ml-auto shrink-0 text-ink-muted" />
        </button>)}
      </div>
    </div>
  </div>;
}

function ChannelStatus({ globalEnabled, channelEnabled, connected, error }: { globalEnabled: boolean; channelEnabled: boolean; connected: boolean; error: string | null }) {
  const label = !globalEnabled ? t("总开关已暂停") : !channelEnabled ? t("渠道已停用") : connected ? t("已連接") : error || t("等待連接");
  const color = globalEnabled && channelEnabled && connected ? "bg-ok" : error && channelEnabled ? "bg-danger" : "bg-ink-muted";
  return <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-muted"><span className={`size-1.5 shrink-0 rounded-full ${color}`} /><span className="truncate" title={error ?? undefined}>{label}</span></span>;
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

function LanguageField({ value, onChange }: { value: MessageBridgeConfig["onebot"]["language"]; onChange: (value: MessageBridgeConfig["onebot"]["language"]) => void }) {
  return <Field label={t("消息語言")}><select className={inputCls} value={value} onChange={(event) => onChange(event.target.value as MessageBridgeConfig["onebot"]["language"])}>
    <option value="zh-TW">繁體中文</option>
    <option value="zh-CN">简体中文</option>
    <option value="en">English</option>
    <option value="ja">日本語</option>
  </select></Field>;
}

function SecretField({ label, value, saved, onChange }: { label: string; value: string; saved: boolean; onChange: (value: string) => void }) {
  return <Field label={label}><input className={inputCls} type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={saved ? t("已保存；留空則不修改") : t("尚未配置")} /></Field>;
}

function AdminField({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [raw, setRaw] = useState(value.join("\n"));
  useEffect(() => setRaw(value.join("\n")), [value]);
  const parse = (raw: string) => [...new Set(raw.split(/[\s,，]+/).map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  return <label className={`${labelCls} sm:col-span-2`}>
    <span className="inline-flex items-center gap-1.5"><FiShield className="text-pal" />{t("渠道管理员用户 ID")}</span>
    <textarea className={`${inputCls} min-h-20 resize-y font-mono text-xs`} value={raw} onChange={(e) => { setRaw(e.target.value); onChange(parse(e.target.value)); }} placeholder={t("每行一个用户 ID；群内发送 /whoami 可查询")} />
  </label>;
}
