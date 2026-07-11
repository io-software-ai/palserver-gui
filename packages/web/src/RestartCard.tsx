import { useCallback, useEffect, useState } from "react";
import { FiAlertTriangle, FiCheck, FiClock, FiCpu, FiRefreshCw, FiX } from "react-icons/fi";
import type { RestartPolicy, RestartStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card, errorCls, inputCls } from "./ui";

const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

const REASON_LABELS: Record<string, string> = {
  scheduled: "定時",
  memory: "記憶體",
  crash: "崩潰",
  manual: "手動",
  "startup-failure": "啟動失敗",
};

/** Automatic-restart policy: scheduled, memory threshold, crash recovery. */
export function RestartCard({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [status, setStatus] = useState<RestartStatus | null>(null);
  const [draft, setDraft] = useState<RestartPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await client.restartPolicy(instanceId);
      setStatus(next);
      setDraft((prev) => prev ?? next.policy);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!status || !draft) return null;

  if (!status.supported) {
    return (
      <div className={card}>
        <h3 className="text-sm font-extrabold text-ink-muted">{t("自動重啟")}</h3>
        <p className="mt-1 text-[13px] text-ink-muted">{status.reason}</p>
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(status.policy);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await client.updateRestartPolicy(instanceId, draft);
      setNotice(t("已儲存自動重啟設定"));
      setTimeout(() => setNotice(null), 3000);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const patch = (p: Partial<RestartPolicy>) => setDraft({ ...draft, ...p });

  return (
    <div className={`${card} flex flex-col gap-4`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
          <FiRefreshCw className="size-4 text-pal" /> {t("自動重啟")}
        </h3>
        <span className="text-xs text-ink-muted">
          {status.memoryMB !== null && `${t("目前記憶體")} ${status.memoryMB} MB · `}
          {t("過去一小時重啟 {n} 次", { n: status.restartsLastHour })}
        </span>
      </div>

      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}

      {/* 定時重啟 */}
      <Section
        icon={<FiClock className="size-4" />}
        title={t("定時重啟")}
        enabled={draft.scheduled.enabled}
        onToggle={(enabled) => patch({ scheduled: { ...draft.scheduled, enabled } })}
      >
        <div className="flex flex-wrap gap-2">
          {(["interval", "daily"] as const).map((mode) => (
            <button
              key={mode}
              className={
                draft.scheduled.mode === mode
                  ? "rounded-full bg-pal px-4 py-1.5 text-[13px] font-extrabold text-white"
                  : "rounded-full border-2 border-line bg-card-soft px-4 py-1.5 text-[13px] font-extrabold text-ink-muted transition hover:border-pal"
              }
              onClick={() => patch({ scheduled: { ...draft.scheduled, mode } })}
            >
              {mode === "interval" ? t("每隔一段時間") : t("每天固定時間")}
            </button>
          ))}
        </div>
        {draft.scheduled.mode === "interval" ? (
          <Field label={t("每隔幾分鐘重啟")}>
            <input
              className={inputCls}
              type="number"
              min={15}
              max={10080}
              value={draft.scheduled.intervalMinutes}
              onChange={(e) =>
                patch({ scheduled: { ...draft.scheduled, intervalMinutes: Number(e.target.value) } })
              }
            />
          </Field>
        ) : (
          <Field label={t("每天的重啟時間(HH:MM,以逗號分隔)")}>
            <input
              className={inputCls}
              value={draft.scheduled.dailyTimes.join(", ")}
              placeholder="05:00, 17:00"
              onChange={(e) =>
                patch({
                  scheduled: {
                    ...draft.scheduled,
                    dailyTimes: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </Field>
        )}
      </Section>

      {/* 記憶體閥值 */}
      <Section
        icon={<FiCpu className="size-4" />}
        title={t("記憶體超過閥值時重啟")}
        enabled={draft.memory.enabled}
        onToggle={(enabled) => patch({ memory: { ...draft.memory, enabled } })}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("閥值(MB)")}>
            <input
              className={inputCls}
              type="number"
              min={512}
              max={262144}
              value={draft.memory.thresholdMB}
              onChange={(e) => patch({ memory: { ...draft.memory, thresholdMB: Number(e.target.value) } })}
            />
          </Field>
          <Field label={t("連續超標幾次才重啟(每次間隔 30 秒)")}>
            <input
              className={inputCls}
              type="number"
              min={1}
              max={20}
              value={draft.memory.sustainedChecks}
              onChange={(e) =>
                patch({ memory: { ...draft.memory, sustainedChecks: Number(e.target.value) } })
              }
            />
          </Field>
        </div>
        <p className="text-xs text-ink-muted">
          {t("需連續超標才會動作,避免一時的記憶體尖峰誤觸發。")}
        </p>
      </Section>

      {/* 崩潰重啟 */}
      <Section
        icon={<FiAlertTriangle className="size-4" />}
        title={t("崩潰後自動重啟")}
        enabled={draft.crash.enabled}
        onToggle={(enabled) => patch({ crash: { ...draft.crash, enabled } })}
      >
        <Field label={t("每小時最多自動重啟次數(超過則停止嘗試)")}>
          <input
            className={inputCls}
            type="number"
            min={1}
            max={20}
            value={draft.crash.maxPerHour}
            onChange={(e) => patch({ crash: { ...draft.crash, maxPerHour: Number(e.target.value) } })}
          />
        </Field>
        <p className="text-xs text-ink-muted">
          {t("手動停止伺服器不會被視為崩潰。達到上限後會停止自動重啟,避免無限重啟迴圈。")}
        </p>
      </Section>

      <Field label={t("計畫性重啟前的預告秒數(0 = 不預告)")}>
        <input
          className={`${inputCls} max-w-40`}
          type="number"
          min={0}
          max={300}
          value={draft.announceSeconds}
          onChange={(e) => patch({ announceSeconds: Number(e.target.value) })}
        />
      </Field>
      <p className="-mt-2 text-xs text-ink-muted">
        {t("會透過 REST API 廣播給線上玩家,並在重啟前先存檔。崩潰重啟不預告(伺服器已經不在了)。")}
      </p>

      <div className="flex gap-2">
        <button className={btn} onClick={save} disabled={!dirty || saving}>
          {saving ? t("儲存中…") : t("儲存設定")}
        </button>
        {dirty && (
          <button className={btnGhost} onClick={() => setDraft(status.policy)} disabled={saving}>
            {t("重置")}
          </button>
        )}
      </div>

      {status.events.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-extrabold text-ink-muted">{t("重啟紀錄")}</h4>
          <div className="flex max-h-56 flex-col divide-y divide-line overflow-y-auto">
            {status.events.map((e, i) => (
              <div key={`${e.at}-${i}`} className="flex items-start gap-2.5 py-2">
                {e.ok ? (
                  <FiCheck className="mt-0.5 size-4 shrink-0 text-grass" />
                ) : (
                  <FiX className="mt-0.5 size-4 shrink-0 text-berry" />
                )}
                <div className="flex-1">
                  <p className="text-[13px] font-bold">
                    {t(REASON_LABELS[e.reason] ?? e.reason)} · {e.detail}
                  </p>
                  <p className="text-xs text-ink-muted">{fmtWhen(e.at)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  enabled,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border-2 border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[13px] font-extrabold">
          <span className="text-pal">{icon}</span>
          {title}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={title}
          onClick={() => onToggle(!enabled)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${enabled ? "bg-grass" : "bg-line"}`}
        >
          <span
            className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${enabled ? "left-6" : "left-1"}`}
          />
        </button>
      </div>
      {enabled && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-bold text-ink-muted">
      {label}
      {children}
    </label>
  );
}
