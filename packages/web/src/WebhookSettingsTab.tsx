import { useCallback, useEffect, useState } from "react";
import {
  FiCheck,
  FiChevronDown,
  FiChevronUp,
  FiEdit2,
  FiLink,
  FiPlus,
  FiRefreshCw,
  FiSend,
  FiStar,
  FiTrash2,
  FiX,
} from "react-icons/fi";
import {
  eventMatches,
  hasFeature,
  WEBHOOK_EVENT_CATALOG,
  type WebhookConfigPublic,
  type WebhookDelivery,
  type WebhookEventType,
  type WebhookFormat,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { CopyPath } from "./CopyPath";
import { t, useI18n } from "./i18n";
import { SponsorLockNotice, EmptyState, btn, btnDanger, btnGhost, card, errorCls, inputCls, labelCls, Select } from "./ui";

const ALL_EVENT_TYPES: WebhookEventType[] = WEBHOOK_EVENT_CATALOG.flatMap((g) => g.events.map((e) => e.type));
const EVENT_LABELS: Partial<Record<WebhookEventType, string>> = Object.fromEntries(
  WEBHOOK_EVENT_CATALOG.flatMap((g) => g.events.map((e) => [e.type, e.label])),
);
/** requires 值 → 提示文字(目前 catalog 只用到 log / boss-mod,paldefender 先備著)。 */
const REQUIRES_HINT: Record<string, string> = {
  log: "需啟用日誌功能",
  paldefender: "需安裝 PalDefender",
  "boss-mod": "需安裝頭目回報模組",
};

interface Draft {
  url: string;
  label: string;
  format: WebhookFormat;
  enabled: boolean;
  selected: Set<WebhookEventType>;
}

function emptyDraft(): Draft {
  return { url: "", label: "", format: "generic", enabled: true, selected: new Set() };
}

/** 既有設定 → 表單草稿:用 eventMatches 把「精確型別 / 命名空間萬用字元 / 全部」統一展開回勾選集合。 */
function draftFromConfig(c: WebhookConfigPublic): Draft {
  return {
    url: c.url,
    label: c.label ?? "",
    format: c.format,
    enabled: c.enabled,
    selected: new Set(ALL_EVENT_TYPES.filter((ty) => eventMatches(c.events, ty))),
  };
}

/** 勾選集合(依 catalog 分組)→ 送出用的事件字串陣列;整組全選就存 "namespace.*",否則逐一存精確型別。 */
function serializeEvents(selected: Set<WebhookEventType>): string[] {
  const out: string[] = [];
  for (const group of WEBHOOK_EVENT_CATALOG) {
    const leaves = group.events.map((e) => e.type);
    if (leaves.length > 0 && leaves.every((l) => selected.has(l))) {
      out.push(`${group.namespace}.*`);
    } else {
      for (const l of leaves) if (selected.has(l)) out.push(l);
    }
  }
  return out;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * Webhook / Discord 機器人整合(贊助者先行版 webhooks):伺服器事件(玩家加入/離開、
 * 頭目擊殺、備份完成等)即時推送到自訂 URL(HMAC 簽章)或 Discord Incoming Webhook。
 * API 見 api.ts 的 webhooks/createWebhook/updateWebhook/.../testWebhook/webhookDeliveries,
 * 型別在 @palserver/shared(WebhookConfigPublic/WebhookDelivery/WEBHOOK_EVENT_CATALOG)。
 *
 * 贊助者先行版:未解鎖時只顯示先行版說明,不顯示表單(比照 BossRespawnTab.tsx)。
 */
export function WebhookSettingsTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookConfigPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createDraft, setCreateDraft] = useState<Draft>(emptyDraft);
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);

  // 進行中的動作(刪除/測試/換密鑰/啟停)綁在單一 webhook id 上,避免同時誤觸多筆。
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; status?: number; error?: string } | null>(
    null,
  );
  const [newSecret, setNewSecret] = useState<{ id: string; secret: string } | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});

  const refresh = useCallback(async () => {
    try {
      setWebhooks(await client.webhooks(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("webhooks", l)))
      .catch(() => setEntitled(false));
  }, [client, instanceId]);

  useEffect(() => {
    if (entitled) void refresh();
  }, [entitled, refresh]);

  const locked = entitled === false;

  // 贊助者限定:未解鎖只顯示先行版說明,下面的表單/清單一律不顯示、也不預覽。
  if (locked) {
    return (
      <div className="flex flex-col gap-4">
        <SponsorLockNotice>{t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}</SponsorLockNotice>
      </div>
    );
  }

  if (entitled === null || webhooks === null) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const { config, secret } = await client.createWebhook(instanceId, {
        url: createDraft.url.trim(),
        label: createDraft.label.trim() || undefined,
        format: createDraft.format,
        enabled: createDraft.enabled,
        events: serializeEvents(createDraft.selected),
      });
      setWebhooks((prev) => [config, ...(prev ?? [])]);
      setNewSecret({ id: config.id, secret });
      setShowCreate(false);
      setCreateDraft(emptyDraft());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (wh: WebhookConfigPublic) => {
    setEditingId(wh.id);
    setEditDraft(draftFromConfig(wh));
  };

  const saveEdit = async (whId: string) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await client.updateWebhook(instanceId, whId, {
        url: editDraft.url.trim(),
        label: editDraft.label.trim() || undefined,
        format: editDraft.format,
        enabled: editDraft.enabled,
        events: serializeEvents(editDraft.selected),
      });
      setWebhooks((prev) => (prev ?? []).map((w) => (w.id === whId ? updated : w)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (whId: string) => {
    if (!confirm(t("確定要刪除這個 Webhook 嗎?此動作無法復原。"))) return;
    setBusyId(whId);
    setError(null);
    try {
      await client.deleteWebhook(instanceId, whId);
      setWebhooks((prev) => (prev ?? []).filter((w) => w.id !== whId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = async (wh: WebhookConfigPublic) => {
    setBusyId(wh.id);
    setError(null);
    try {
      const updated = await client.updateWebhook(instanceId, wh.id, { enabled: !wh.enabled });
      setWebhooks((prev) => (prev ?? []).map((w) => (w.id === wh.id ? updated : w)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const rotateSecret = async (whId: string) => {
    if (!confirm(t("重生密鑰後,舊密鑰立即失效,使用舊密鑰驗證簽章的服務將會失敗。確定要重生嗎?"))) return;
    setBusyId(whId);
    setError(null);
    try {
      const { secret } = await client.rotateWebhookSecret(instanceId, whId);
      setNewSecret({ id: whId, secret });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const runTest = async (whId: string) => {
    setBusyId(whId);
    setTestResult(null);
    setError(null);
    try {
      const { result } = await client.testWebhook(instanceId, whId);
      setTestResult({ id: whId, ...result });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const toggleDeliveries = async (whId: string) => {
    if (expandedId === whId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(whId);
    if (!deliveries[whId]) {
      try {
        const list = await client.webhookDeliveries(instanceId, whId);
        setDeliveries((prev) => ({ ...prev, [whId]: list }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}

      <p className="text-xs text-ink-muted">
        {t(
          "當伺服器發生指定事件(玩家加入/離開、頭目擊殺、備份完成等)時,即時發送到你的 URL——可直接貼 Discord 頻道的 Incoming Webhook,或串接自訂 HTTP 端點(含 HMAC 簽章驗證)。",
        )}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-sm font-extrabold text-ink-muted">
          <FiLink className="size-4 text-pal" /> {t("你的 Webhook")}
          <span className="inline-flex items-center gap-1 rounded-full bg-pal/10 px-2 py-0.5 text-xs font-bold text-pal">
            <FiStar className="size-3" /> {t("贊助者")}
          </span>
        </p>
        {!showCreate && (
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => {
              setCreateDraft(emptyDraft());
              setShowCreate(true);
            }}
          >
            <FiPlus className="size-4" /> {t("新增 Webhook")}
          </button>
        )}
      </div>

      {showCreate && (
        <WebhookForm
          draft={createDraft}
          setDraft={setCreateDraft}
          onSubmit={() => void create()}
          onCancel={() => setShowCreate(false)}
          busy={creating}
          submitLabel={t("建立")}
          busyLabel={t("建立中…")}
        />
      )}

      {webhooks.length === 0 && !showCreate ? (
        <EmptyState icon={<FiLink />}>
          {t("尚未設定任何 Webhook。點上方「新增 Webhook」開始接收伺服器事件通知。")}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {webhooks.map((wh) => (
            <div key={wh.id} className={`${card} flex flex-col gap-3`}>
              {newSecret?.id === wh.id && (
                <div className="flex flex-col gap-1.5 rounded-xl border-2 border-sun/40 bg-sun/10 px-3 py-2">
                  <p className="text-xs font-bold text-sun">
                    {t("密鑰只會顯示這一次,請立即複製保存;之後將無法再次查看,只能重新產生。")}
                  </p>
                  <div className="flex items-center gap-2">
                    <CopyPath value={newSecret.secret} className={`${inputCls} min-w-0 flex-1`} secret />
                    <button className={btnGhost} onClick={() => setNewSecret(null)}>
                      {t("知道了")}
                    </button>
                  </div>
                </div>
              )}

              {editingId === wh.id ? (
                <WebhookForm
                  draft={editDraft}
                  setDraft={setEditDraft}
                  onSubmit={() => void saveEdit(wh.id)}
                  onCancel={() => setEditingId(null)}
                  busy={saving}
                  submitLabel={t("儲存")}
                  busyLabel={t("儲存中…")}
                />
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-extrabold">{wh.label || t("(未命名)")}</p>
                      <p className="truncate text-xs text-ink-muted" title={wh.url}>
                        {wh.url}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-card-soft px-2 py-0.5 text-[11px] font-bold text-ink-muted">
                        {wh.format === "discord" ? t("Discord(Incoming Webhook)") : t("自訂端點(HMAC 簽章)")}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                          wh.enabled ? "bg-grass/15 text-grass" : "bg-card-soft text-ink-muted"
                        }`}
                      >
                        {wh.enabled ? t("已啟用") : t("已停用")}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {wh.events.map((ev) => (
                      <span key={ev} className="rounded-full bg-card-soft px-2 py-0.5 font-mono text-[11px] text-ink-muted">
                        {ev}
                      </span>
                    ))}
                  </div>

                  <div className="rounded-xl bg-card-soft px-3 py-2 text-[13px]">
                    {wh.lastDelivery ? (
                      wh.lastDelivery.ok ? (
                        <p className="font-bold text-grass">
                          {t("上次送出成功:{time}", { time: fmtTime(wh.lastDelivery.at) })}
                        </p>
                      ) : (
                        <p className="font-bold text-berry">
                          {t("上次送出失敗:{time}", { time: fmtTime(wh.lastDelivery.at) })}
                          {wh.lastDelivery.error && (
                            <span className="mt-0.5 block font-normal">{wh.lastDelivery.error}</span>
                          )}
                        </p>
                      )
                    ) : (
                      <p className="text-ink-muted">{t("尚未送出過")}</p>
                    )}
                  </div>

                  {testResult?.id === wh.id && (
                    <p className={`text-xs font-bold ${testResult.ok ? "text-grass" : "text-berry"}`}>
                      {testResult.ok
                        ? t("測試成功({status})", { status: testResult.status ?? "" })
                        : t("測試失敗:{error}", { error: testResult.error ?? "" })}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    <button
                      className={`${btnGhost} inline-flex items-center gap-1.5 text-xs`}
                      onClick={() => void runTest(wh.id)}
                      disabled={busyId === wh.id}
                    >
                      <FiSend className="size-3.5" /> {busyId === wh.id ? t("測試中…") : t("測試")}
                    </button>
                    <button
                      className={`${btnGhost} inline-flex items-center gap-1.5 text-xs`}
                      onClick={() => startEdit(wh)}
                      disabled={busyId === wh.id}
                    >
                      <FiEdit2 className="size-3.5" /> {t("編輯")}
                    </button>
                    <button
                      className={`${btnGhost} inline-flex items-center gap-1.5 text-xs`}
                      onClick={() => void toggleEnabled(wh)}
                      disabled={busyId === wh.id}
                    >
                      {wh.enabled ? t("停用") : t("啟用")}
                    </button>
                    <button
                      className={`${btnGhost} inline-flex items-center gap-1.5 text-xs`}
                      onClick={() => void rotateSecret(wh.id)}
                      disabled={busyId === wh.id}
                    >
                      <FiRefreshCw className="size-3.5" /> {t("重生密鑰")}
                    </button>
                    <button
                      className={`${btnGhost} inline-flex items-center gap-1.5 text-xs`}
                      onClick={() => void toggleDeliveries(wh.id)}
                    >
                      {expandedId === wh.id ? (
                        <FiChevronUp className="size-3.5" />
                      ) : (
                        <FiChevronDown className="size-3.5" />
                      )}
                      {t("送出紀錄")}
                    </button>
                    <button
                      className={`${btnDanger} inline-flex items-center gap-1.5 text-xs`}
                      onClick={() => void remove(wh.id)}
                      disabled={busyId === wh.id}
                    >
                      <FiTrash2 className="size-3.5" /> {t("刪除")}
                    </button>
                  </div>

                  {expandedId === wh.id && (
                    <div className="rounded-xl border-2 border-line p-3">
                      <DeliveryList deliveries={deliveries[wh.id]} />
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 事件分組勾選:每組一個「全選該組」checkbox(indeterminate 表示只選了一部分)+ 逐一勾選。 */
export function EventPicker({
  selected,
  onChange,
}: {
  selected: Set<WebhookEventType>;
  onChange: (next: Set<WebhookEventType>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {WEBHOOK_EVENT_CATALOG.map((group) => {
        const leaves = group.events.map((e) => e.type);
        const allSelected = leaves.length > 0 && leaves.every((l) => selected.has(l));
        const someSelected = !allSelected && leaves.some((l) => selected.has(l));
        return (
          <div key={group.namespace} className="rounded-xl border-2 border-line p-3">
            <label className="mb-2 inline-flex cursor-pointer items-center gap-2 text-sm font-extrabold">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={(e) => {
                  const next = new Set(selected);
                  for (const l of leaves) {
                    if (e.target.checked) next.add(l);
                    else next.delete(l);
                  }
                  onChange(next);
                }}
              />
              {t(group.label)}
            </label>
            <div className="grid grid-cols-1 gap-1.5 pl-1 sm:grid-cols-2">
              {group.events.map((ev) => (
                <label
                  key={ev.type}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-bold text-ink-muted"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(ev.type)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(ev.type);
                      else next.delete(ev.type);
                      onChange(next);
                    }}
                  />
                  {t(ev.label)}
                  {ev.requires && (
                    <span className="text-[10px] font-normal text-sun">({t(REQUIRES_HINT[ev.requires])})</span>
                  )}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 新增 / 編輯共用的表單(建立與編輯欄位完全一致)。 */
function WebhookForm({
  draft,
  setDraft,
  onSubmit,
  onCancel,
  busy,
  submitLabel,
  busyLabel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  submitLabel: string;
  busyLabel: string;
}) {
  const canSubmit = draft.url.trim() !== "" && draft.selected.size > 0 && !busy;
  return (
    <div className={`${card} flex flex-col gap-3`}>
      <label className={labelCls}>
        {t("Webhook 網址")}
        <input
          className={inputCls}
          value={draft.url}
          placeholder={t("https://example.com/webhook 或 Discord 頻道 Webhook 網址")}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        />
      </label>
      <label className={labelCls}>
        {t("顯示名稱(選填)")}
        <input
          className={inputCls}
          value={draft.label}
          placeholder={t("方便你自己識別,例如:公告頻道")}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
      </label>
      <label className={labelCls}>
        {t("格式")}
        <Select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value as WebhookFormat })}>
          <option value="generic">{t("自訂端點(HMAC 簽章)")}</option>
          <option value="discord">{t("Discord(Incoming Webhook)")}</option>
        </Select>
        <span className="text-[11px] font-normal text-ink-muted">
          {draft.format === "discord"
            ? t("直接以 Discord Incoming Webhook 格式發送 embed 訊息,貼上 Discord 頻道設定裡的 Webhook 網址即可。")
            : t("以 JSON 格式 POST 到你的伺服器,並附上 HMAC-SHA256 簽章(X-Palserver-Signature)供你驗證來源。")}
        </span>
      </label>
      <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-bold">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        {t("啟用")}
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-bold text-ink-muted">{t("訂閱事件")}</span>
        <EventPicker selected={draft.selected} onChange={(next) => setDraft({ ...draft, selected: next })} />
        {draft.selected.size === 0 && (
          <span className="text-[11px] font-bold text-sun">{t("請至少選擇一個事件")}</span>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onCancel} disabled={busy}>
          {t("取消")}
        </button>
        <button className={btn} onClick={onSubmit} disabled={!canSubmit}>
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </div>
  );
}

/** 單一 webhook 的送出日誌(deliveries)。 */
function DeliveryList({ deliveries }: { deliveries: WebhookDelivery[] | undefined }) {
  if (deliveries === undefined) return <p className="text-xs text-ink-muted">{t("載入中…")}</p>;
  if (deliveries.length === 0) return <p className="text-xs text-ink-muted">{t("尚無送出紀錄。")}</p>;
  return (
    <div className="flex flex-col divide-y divide-line">
      {deliveries.map((d) => (
        <div key={d.deliveryId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
          <span className="font-bold">{EVENT_LABELS[d.event] ? t(EVENT_LABELS[d.event]!) : t("Ping 測試")}</span>
          <span className="text-ink-muted">{fmtTime(d.at)}</span>
          {d.ok ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-grass/15 px-2 py-0.5 font-bold text-grass">
              <FiCheck className="size-3" /> {d.status ?? "OK"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-berry/10 px-2 py-0.5 font-bold text-berry">
              <FiX className="size-3" /> {d.status ?? "Error"}
            </span>
          )}
          {d.attempts > 1 && <span className="text-ink-muted">{t("重試 {n} 次", { n: d.attempts })}</span>}
          {d.error && <span className="w-full text-berry">{d.error}</span>}
        </div>
      ))}
    </div>
  );
}
