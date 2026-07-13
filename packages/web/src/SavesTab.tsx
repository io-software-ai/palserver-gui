import { useCallback, useEffect, useState } from "react";
import {
  FiArchive,
  FiCheck,
  FiClock,
  FiDownload,
  FiFolder,
  FiPlay,
  FiRotateCcw,
  FiSave,
  FiTrash2,
  FiUser,
} from "react-icons/fi";
import type { BackupSchedule, InstanceSummary, SavesStatus, WorldSave } from "@palserver/shared";
import type { AgentClient } from "./api";
import { FileBrowserDialog } from "./FileManager";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card, errorCls, inputCls } from "./ui";

/** Where a world's .sav files live, relative to the server directory. */
const worldPath = (guid: string) => `Pal/Saved/SaveGames/0/${guid}`;

const fmtSize = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`;
const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

export function SavesTab({
  client,
  instanceId,
  running,
}: {
  client: AgentClient;
  instanceId: string;
  running: boolean;
}) {
  useI18n();
  const [saves, setSaves] = useState<SavesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSaves(await client.saves(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 4000);
  };

  const act = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      flash(success);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!saves) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;

  if (!saves.supported && saves.worlds.length === 0 && saves.backups.length === 0) {
    return (
      <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-12 text-center text-ink-muted">
        <FiArchive className="mx-auto mb-2 size-11" />
        <p className="font-bold">{t("尚無存檔")}</p>
        <p className="mt-1 text-[13px]">{saves.reason}</p>
      </div>
    );
  }

  const restore = async (name: string) => {
    if (
      !confirm(
        t("還原備份「{name}」會覆蓋目前的世界存檔。\n\n還原前會自動先幫現有存檔做一份安全備份。確定要繼續嗎?", { name }),
      )
    )
      return;
    await act(async () => {
      const res = await client.restoreBackup(instanceId, name);
      flash(t("已還原 {guid};原存檔已備份為 {backup}", { guid: res.worldGuid, backup: res.safetyBackup }));
    }, t("已還原"));
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}
      {running && (
        <p className="rounded-xl bg-sun/10 px-3 py-2 text-[13px] font-bold text-sun">
          {t("伺服器運作中:可以建立備份,但還原存檔、切換世界、刪除玩家存檔需要先停止伺服器。")}
        </p>
      )}

      <MirrorCard
        client={client}
        instanceId={instanceId}
        busy={busy}
        onError={setError}
        onNotice={flash}
      />

      <ScheduleCard
        client={client}
        instanceId={instanceId}
        schedule={saves.schedule}
        busy={busy}
        onChanged={refresh}
        onError={setError}
        onNotice={flash}
      />

      {saves.worlds.map((world) => (
        <WorldCard
          key={world.guid}
          world={world}
          busy={busy}
          running={running}
          onBackup={() => act(() => client.createBackup(instanceId, world.guid), t("已建立備份"))}
          onActivate={() =>
            act(() => client.setActiveWorld(instanceId, world.guid), t("已設為啟用世界(下次啟動生效)"))
          }
          onBrowse={() => setBrowsing(worldPath(world.guid))}
          onDeletePlayer={(file) => {
            if (!confirm(t("刪除玩家存檔「{file}」後,該玩家再次加入時會是全新角色。\n\n確定嗎?", { file }))) return;
            void act(() => client.deletePlayerSave(instanceId, world.guid, file), t("已刪除玩家存檔"));
          }}
        />
      ))}

      <div className={`${card} p-0`}>
        <h3 className="border-b-2 border-line px-5 py-3 text-sm font-extrabold text-ink-muted">
          {t("備份")}({saves.backups.length})
        </h3>
        {saves.backups.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13px] text-ink-muted">{t("尚無備份。")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {saves.backups.map((backup) => (
              <div key={backup.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <div className="min-w-52 flex-1">
                  <p className="font-mono text-[13px] font-bold break-all">{backup.name}</p>
                  <p className="text-xs text-ink-muted">
                    {fmtWhen(backup.createdAt)} · {fmtSize(backup.sizeBytes)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <a
                    className={`${btnGhost} inline-flex items-center gap-1.5`}
                    href={client.backupDownloadUrl(instanceId, backup.name)}
                    download
                  >
                    <FiDownload className="size-3.5" /> {t("下載")}
                  </a>
                  <button
                    className={`${btnGhost} inline-flex items-center gap-1.5`}
                    onClick={() => restore(backup.name)}
                    disabled={busy || running}
                    title={running ? t("請先停止伺服器") : undefined}
                  >
                    <FiRotateCcw className="size-3.5" /> {t("還原")}
                  </button>
                  <button
                    className={`${btnGhost} inline-flex items-center gap-1.5 text-berry hover:border-berry`}
                    onClick={() => {
                      if (confirm(t("刪除備份「{name}」?", { name: backup.name })))
                        void act(() => client.deleteBackup(instanceId, backup.name), t("已刪除備份"));
                    }}
                    disabled={busy}
                  >
                    <FiTrash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
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
    </div>
  );
}

function WorldCard({
  world,
  busy,
  running,
  onBackup,
  onActivate,
  onBrowse,
  onDeletePlayer,
}: {
  world: WorldSave;
  busy: boolean;
  running: boolean;
  onBackup: () => void;
  onActivate: () => void;
  onBrowse: () => void;
  onDeletePlayer: (file: string) => void;
}) {
  const [showPlayers, setShowPlayers] = useState(false);
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-mono text-sm font-extrabold break-all">
            {world.guid}
            {world.active && (
              <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-grass/40 bg-grass/15 px-2 py-0.5 font-sans text-xs font-bold text-grass">
                <FiCheck className="size-3" /> {t("啟用中")}
              </span>
            )}
          </p>
          <p className="mt-1 text-[13px] text-ink-muted">
            {fmtSize(world.sizeBytes)} · {t("{n} 位玩家存檔", { n: world.playerSaves.length })} · {t("更新於")}{" "}
            {fmtWhen(world.modifiedAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={`${btn} inline-flex items-center gap-1.5`}
            onClick={onBackup}
            disabled={busy}
          >
            <FiSave className="size-4" /> {t("立即備份")}
          </button>
          {!world.active && (
            <button
              className={btnGhost}
              onClick={onActivate}
              disabled={busy || running}
              title={running ? t("請先停止伺服器") : t("把伺服器指向這個世界")}
            >
              {t("設為啟用世界")}
            </button>
          )}
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={onBrowse}
            title={t("瀏覽、編輯或上傳這個世界的存檔檔案")}
          >
            <FiFolder className="size-4" /> {t("開啟存檔資料夾")}
          </button>
          {world.playerSaves.length > 0 && (
            <button className={btnGhost} onClick={() => setShowPlayers((v) => !v)}>
              <FiUser className="inline size-4" /> {t("玩家存檔")}
            </button>
          )}
        </div>
      </div>

      {showPlayers && (
        <div className="mt-3 flex flex-col divide-y divide-line border-t-2 border-line">
          {world.playerSaves.map((p) => (
            <div key={p.file} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="font-mono text-xs font-bold break-all">{p.playerUid}</p>
                <p className="text-xs text-ink-muted">{(p.sizeBytes / 1024).toFixed(0)} KB</p>
              </div>
              <button
                className={`${btnGhost} inline-flex shrink-0 items-center gap-1.5 text-berry hover:border-berry`}
                onClick={() => onDeletePlayer(p.file)}
                disabled={busy || running}
                title={running ? t("請先停止伺服器") : t("刪除後該玩家會以全新角色加入")}
              >
                <FiTrash2 className="size-3.5" /> {t("刪除")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleCard({
  client,
  instanceId,
  schedule,
  busy,
  onChanged,
  onError,
  onNotice,
}: {
  client: AgentClient;
  instanceId: string;
  schedule: BackupSchedule;
  busy: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [draft, setDraft] = useState(schedule);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(schedule), [schedule]);

  const dirty =
    draft.enabled !== schedule.enabled ||
    draft.intervalMinutes !== schedule.intervalMinutes ||
    draft.keep !== schedule.keep ||
    draft.skipWhenEmpty !== schedule.skipWhenEmpty;

  const save = async () => {
    setSaving(true);
    try {
      await client.updateBackupSchedule(instanceId, draft);
      onNotice(t("已儲存自動備份設定"));
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setSaving(true);
    try {
      const result = await client.runBackupSchedule(instanceId);
      onNotice(t("測試執行:{result}", { result: result.lastResult ?? "" }));
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`${card} flex flex-col gap-3`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
          <FiClock className="size-4 text-pal" /> {t("自動備份")}
        </h3>
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
          className={`relative h-7 w-12 rounded-full transition ${draft.enabled ? "bg-grass" : "bg-line"}`}
        >
          <span
            className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${draft.enabled ? "left-6" : "left-1"}`}
          />
        </button>
      </div>

      {draft.enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] font-bold text-ink-muted">
            {t("每隔幾分鐘備份")}
            <input
              className={inputCls}
              type="number"
              min={5}
              max={1440}
              value={draft.intervalMinutes}
              onChange={(e) => setDraft((d) => ({ ...d, intervalMinutes: Number(e.target.value) }))}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-bold text-ink-muted">
            {t("保留幾份備份")}
            <input
              className={inputCls}
              type="number"
              min={1}
              max={100}
              value={draft.keep}
              onChange={(e) => setDraft((d) => ({ ...d, keep: Number(e.target.value) }))}
            />
          </label>
          <label className="flex items-center gap-2 text-[13px] font-bold text-ink-muted sm:col-span-2">
            <input
              type="checkbox"
              className="accent-(--color-pal)"
              checked={draft.skipWhenEmpty}
              onChange={(e) => setDraft((d) => ({ ...d, skipWhenEmpty: e.target.checked }))}
            />
            {t("沒有玩家在線上時跳過(避免堆積一模一樣的備份)")}
          </label>
        </div>
      )}

      <p className="text-[13px] text-ink-muted">
        {schedule.lastRunAt
          ? `${t("上次執行")} ${fmtWhen(schedule.lastRunAt)} — ${schedule.lastResult ?? ""}`
          : t("尚未執行過。備份只在伺服器運作中進行。")}
      </p>

      <div className="flex gap-2">
        <button className={btn} onClick={save} disabled={!dirty || saving || busy}>
          {saving ? t("儲存中…") : t("儲存設定")}
        </button>
        <button
          className={`${btnGhost} inline-flex items-center gap-1.5`}
          onClick={runNow}
          disabled={saving || busy}
        >
          <FiPlay className="size-4" /> {t("立即測試執行")}
        </button>
      </div>
    </div>
  );
}

/** 鏡像遷移卡片：把此實例的存檔+INI 鏡像到同 agent 的其他實例。 */
function MirrorCard({
  client,
  instanceId,
  busy,
  onError,
  onNotice,
}: {
  client: AgentClient;
  instanceId: string;
  busy: boolean;
  onError: (e: string) => void;
  onNotice: (t: string) => void;
}) {
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [targetId, setTargetId] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    client.listInstances().then((list) => {
      setInstances(list.filter((i) => i.id !== instanceId));
    }).catch(() => {});
  }, [client, instanceId]);

  if (!open) {
    return (
      <div className={`${card} flex flex-wrap items-center justify-between gap-2`}>
        <div className="min-w-0">
          <p className="text-sm font-bold">{t("鏡像遷移")}</p>
          <p className="text-xs text-ink-muted">{t("把此實例的存檔與世界設定複製到其他實例")}</p>
        </div>
        <button className={`${btnGhost} shrink-0`} onClick={() => setOpen(true)} disabled={busy || instances.length === 0}>
          {t("鏡像到…")}
        </button>
      </div>
    );
  }

  const doMirror = async () => {
    if (!targetId) return;
    try {
      const res = await client.mirrorWorld(instanceId, targetId);
      onNotice(t("已鏡像到目標實例(worldguid: {guid})", { guid: res.worldGuid.slice(0, 8) }));
      setOpen(false);
      setTargetId("");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={card}>
      <p className="text-sm font-bold">{t("鏡像遷移")}</p>
      <p className="mb-3 text-xs text-ink-muted">
        {t("選擇目標實例。此實例的存檔、世界 INI、GameUserSettings 會複製過去,目標的 DedicatedServerName 會改為此實例的 worldguid。")}
      </p>
      <div className="flex flex-col gap-2">
        <select
          className={inputCls}
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
        >
          <option value="">{t("選擇目標實例…")}</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>{i.name} ({i.backend})</option>
          ))}
        </select>
        <div className="flex gap-2">
          <button className={btn} onClick={doMirror} disabled={!targetId || busy}>
            {t("執行鏡像")}
          </button>
          <button className={btnGhost} onClick={() => setOpen(false)}>
            {t("取消")}
          </button>
        </div>
      </div>
    </div>
  );
}
