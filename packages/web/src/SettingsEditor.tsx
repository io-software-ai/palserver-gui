import { useCallback, useEffect, useMemo, useState } from "react";
import { FiFileText, FiAlertTriangle, FiSearch } from "react-icons/fi";
import type { FileHealth, OptionMeta } from "@palserver/shared";
import {
  OPTION_CATEGORIES,
  WORLD_OPTIONS,
  optionKeysByCategory,
  type OptionCategory,
  type WorldOptionKey,
  type WorldOptionValue,
  type WorldSettings,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { FileEditor } from "./FileManager";
import { ConfigCorruptModal } from "./ConfigCorruptModal";
import { CATEGORY_LABELS, ENUM_LABELS, OPTION_LABELS } from "./labels";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, errorCls, inputCls } from "./ui";

/** Where the native driver renders the ini, relative to the server dir. */
const INI_PATHS = [
  "Pal/Saved/Config/WindowsServer/PalWorldSettings.ini",
  "Pal/Saved/Config/LinuxServer/PalWorldSettings.ini",
];

/** Schema-driven world-settings editor. Renders every option in
 * WORLD_OPTIONS by its metadata; no per-option UI code. */
export function SettingsEditor({
  settings,
  saving,
  onSave,
  client,
  instanceId,
  canEditRaw,
  running,
  onSynced,
}: {
  settings: WorldSettings;
  saving: boolean;
  onSave: (patch: Partial<WorldSettings>) => Promise<void>;
  client: AgentClient;
  instanceId: string;
  canEditRaw: boolean;
  running: boolean;
  /** ini 外部改動同步回 store 後通知父層重拉(面板值才會立即更新) */
  onSynced?: () => void;
}) {
  useI18n();
  const [category, setCategory] = useState<OptionCategory>("server");
  // 搜尋:比對「翻譯後標籤 + ini key + hint」,有輸入時跨分類顯示
  const [search, setSearch] = useState("");
  const visibleKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return optionKeysByCategory(category);
    return (Object.keys(WORLD_OPTIONS) as WorldOptionKey[]).filter((key) => {
      const meta = WORLD_OPTIONS[key] as OptionMeta;
      return (
        key.toLowerCase().includes(q) ||
        t(OPTION_LABELS[key]).toLowerCase().includes(q) ||
        (meta.hint ? t(meta.hint).toLowerCase().includes(q) : false)
      );
    });
  }, [search, category]);
  const [draft, setDraft] = useState<Partial<WorldSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const [rawPath, setRawPath] = useState<string | null>(null);
  const [corrupt, setCorrupt] = useState<FileHealth | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!canEditRaw) return;
    client
      .configHealth(instanceId)
      .then((h) => setCorrupt(h.world.corrupted ? h.world : null))
      .catch(() => setCorrupt(null));
  }, [client, instanceId, canEditRaw]);

  // 開面板時把 ini 的外部改動(外部編輯器/檔案總管改的)併回 store —— 否則面板
  // 顯示的是 store 舊值,下次啟動還會把外部改動蓋掉。k8s 端點回空 patch,無害。
  const syncIni = useCallback(() => {
    client
      .syncWorldIni(instanceId)
      .then((r) => {
        if (r.changedKeys.length > 0) onSynced?.();
      })
      .catch(() => {});
  }, [client, instanceId, onSynced]);

  useEffect(() => {
    syncIni();
  }, [syncIni]);

  const dirtyKeys = useMemo(
    () =>
      (Object.keys(draft) as WorldOptionKey[]).filter(
        (k) => draft[k] !== undefined && draft[k] !== settings[k],
      ),
    [draft, settings],
  );

  const valueOf = (key: WorldOptionKey): WorldOptionValue =>
    draft[key] !== undefined ? draft[key]! : settings[key];

  const setValue = (key: WorldOptionKey, value: WorldOptionValue) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setError(null);
    const patch = Object.fromEntries(dirtyKeys.map((k) => [k, draft[k]]));
    try {
      await onSave(patch);
      setDraft({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** The ini lives under the platform dir of whichever OS the agent runs on;
   * try Windows first and fall back to Linux. */
  const openRaw = async () => {
    setError(null);
    for (const candidate of INI_PATHS) {
      try {
        await client.readFile(instanceId, candidate);
        setRawPath(candidate);
        return;
      } catch {
        /* try next */
      }
    }
    setError(t("找不到 PalWorldSettings.ini — 先啟動一次伺服器讓它生成設定檔"));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <FiSearch className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              className={`${inputCls} w-44 py-1.5 pl-8 text-[13px]`}
              value={search}
              placeholder={t("搜尋設定…")}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {!search.trim() && OPTION_CATEGORIES.map((c) => (
            <button
              key={c}
              className={
                c === category
                  ? "rounded-full bg-pal px-4 py-1.5 text-[13px] font-extrabold text-white"
                  : "rounded-full border-2 border-line bg-card-soft px-4 py-1.5 text-[13px] font-extrabold text-ink-muted transition hover:border-pal"
              }
              onClick={() => setCategory(c)}
            >
              {t(CATEGORY_LABELS[c])}
            </button>
          ))}
        </div>
        {canEditRaw && (
          <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={openRaw}>
            <FiFileText className="size-4" /> {t("編輯原始檔")}
          </button>
        )}
      </div>

      <div className="flex flex-col divide-y divide-line">
        {visibleKeys.map((key) => (
          <OptionRow key={key} optionKey={key} value={valueOf(key)} onChange={(v) => setValue(key, v)} />
        ))}
        {search.trim() && visibleKeys.length === 0 && (
          <p className="py-6 text-center text-[13px] text-ink-muted">{t("沒有符合「{q}」的設定。", { q: search.trim() })}</p>
        )}
      </div>

      {error && <p className={errorCls}>{error}</p>}
      {dirtyKeys.length > 0 && (
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-(--radius-cute) border-2 border-sun/50 bg-card p-3 shadow-(--shadow-cute)">
          <span className="text-[13px] font-bold text-ink-muted">
            {t("小心~您有 {n} 項變更尚未儲存!(重啟伺服器後生效)", { n: dirtyKeys.length })}
          </span>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={() => setDraft({})} disabled={saving}>
              {t("重置")}
            </button>
            <button className={btn} onClick={save} disabled={saving}>
              {saving ? t("儲存中…") : t("確定修改")}
            </button>
          </div>
        </div>
      )}

      {rawPath && (
        <FileEditor
          client={client}
          instanceId={instanceId}
          path={rawPath}
          onSaved={syncIni} // 原始檔存檔後立刻把改動併回 store,面板才會同步顯示
          onClose={() => setRawPath(null)}
        />
      )}

      {corrupt && !dismissed && (
        <ConfigCorruptModal
          client={client}
          instanceId={instanceId}
          file="world"
          health={corrupt}
          running={running}
          onResolved={() => setDismissed(true)}
        />
      )}
    </div>
  );
}

function OptionRow({
  optionKey,
  value,
  onChange,
}: {
  optionKey: WorldOptionKey;
  value: WorldOptionValue;
  onChange: (v: WorldOptionValue) => void;
}) {
  useI18n();
  // as OptionMeta:WORLD_OPTIONS 是 as const 的字面型別,沒寫 hint 的項在聯集裡缺該屬性。
  const meta = WORLD_OPTIONS[optionKey] as OptionMeta;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-52 max-w-xl">
        <p className="text-sm font-bold">{t(OPTION_LABELS[optionKey])}</p>
        <p className="text-xs text-ink-muted">{optionKey}</p>
        {meta.hint && <p className="mt-1 text-xs text-ink-muted">{t(meta.hint)}</p>}
        {meta.warn && (
          <p className="mt-1 inline-flex items-start gap-1.5 text-xs font-bold text-sun">
            <FiAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t(meta.warn)}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {meta.type === "bool" && (
          <Toggle checked={Boolean(value)} onChange={(v) => onChange(v)} />
        )}
        {(meta.type === "float" || meta.type === "int") &&
          (() => {
            const soft = (meta as { soft?: boolean }).soft === true;
            const num = Number(value);
            const outOfRange = soft && (num < meta.min || num > meta.max);
            return (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    className={`${inputCls} w-24 text-right`}
                    value={String(value)}
                    // soft 選項:數字框放行超出建議範圍的極端值(只擋負值);滑桿仍限在建議範圍內。
                    min={soft ? 0 : meta.min}
                    max={soft ? undefined : meta.max}
                    step={meta.type === "float" ? meta.step : 1}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (!Number.isNaN(n)) onChange(meta.type === "int" ? Math.trunc(n) : n);
                    }}
                  />
                  <input
                    type="range"
                    className="w-40 accent-(--color-pal) sm:w-56"
                    value={Math.min(Math.max(num, meta.min), meta.max)}
                    min={meta.min}
                    max={meta.max}
                    step={meta.type === "float" ? meta.step : 1}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      onChange(meta.type === "int" ? Math.trunc(n) : n);
                    }}
                  />
                </div>
                {outOfRange && (
                  <p className="inline-flex items-center gap-1 text-[11px] font-bold text-sun">
                    <FiAlertTriangle className="size-3 shrink-0" />
                    {t("超出建議範圍 {min}–{max},遊戲可能有非預期行為", { min: meta.min, max: meta.max })}
                  </p>
                )}
              </div>
            );
          })()}
        {meta.type === "enum" && (
          <select
            className={`${inputCls} min-w-36`}
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
          >
            {meta.choices.map((c) => (
              <option key={c} value={c}>
                {t(ENUM_LABELS[c] ?? c)}
              </option>
            ))}
          </select>
        )}
        {meta.type === "string" && (
          <input
            type={"secret" in meta && meta.secret ? "password" : "text"}
            className={`${inputCls} w-56`}
            value={String(value)}
            maxLength={meta.maxLength}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 rounded-full transition ${checked ? "bg-grass" : "bg-line"}`}
    >
      <span
        className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${checked ? "left-6" : "left-1"}`}
      />
    </button>
  );
}
