import { useState } from "react";
import { FiAlertTriangle, FiCheck, FiDownload, FiSearch, FiX } from "react-icons/fi";
import type { ExternalWorldCandidate, InstanceSummary } from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { Overlay } from "./ui";
import { btn, btnGhost, card, errorCls, inputCls } from "./ui";

/** 匯入來源類型 — 只影響引導文字,實際掃描/匯入邏輯三者相同
 *  (磁碟上都是「含 Level.sav 的世界資料夾」,見 docs/MIGRATION.md)。 */
type SourceKind = "dedicated" | "v1" | "coop";

const SOURCE_OPTIONS: { kind: SourceKind; label: string; hint: string }[] = [
  {
    kind: "dedicated",
    label: "其他專用伺服器",
    hint: "到舊伺服器的 Pal/Saved/SaveGames/0/ 找到世界資料夾(一串英數字 GUID),把它(或其任一上層目錄)的完整路徑貼到下面。",
  },
  {
    kind: "v1",
    label: "舊版 1.0 GUI",
    hint: "在 v1 介面按「開啟伺服器資料夾」,把那個伺服器目錄的路徑貼到下面。小提示:v1 伺服器在同一台機器時,也可以改用「建立伺服器」時填「既有伺服器路徑」直接原地收編,連搬都不用搬。",
  },
  {
    kind: "coop",
    label: "本機共玩存檔",
    hint: "本機(四人邀請碼)存檔在 %LOCALAPPDATA%\\Pal\\Saved\\SaveGames\\<SteamID>\\ 底下。注意:主機玩家的角色需要用社群工具 palworld-host-save-fix 轉換,否則進伺服器會被要求重建角色(帕魯與建築不受影響)。",
  },
];

export function ImportSaveModal({
  client,
  instances,
  onClose,
  onDone,
}: {
  client: AgentClient;
  instances: InstanceSummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  useI18n();
  const eligible = instances.filter((i) => i.backend !== "k8s");
  const [kind, setKind] = useState<SourceKind>("dedicated");
  const [sourcePath, setSourcePath] = useState("");
  const [worlds, setWorlds] = useState<ExternalWorldCandidate[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string>(eligible[0]?.id ?? "");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ worldGuid: string; backedUp: boolean } | null>(null);

  const target = eligible.find((i) => i.id === targetId) ?? null;
  const targetRunning = target !== null && target.status !== "created" && target.status !== "exited" && target.status !== "missing";
  const pickedWorld = worlds?.find((w) => w.path === picked) ?? null;

  const scan = async () => {
    setBusy(true);
    setError(null);
    setWorlds(null);
    setPicked(null);
    try {
      const r = await client.inspectImportSave(sourcePath.trim());
      setWorlds(r.worlds);
      if (r.worlds.length === 1) setPicked(r.worlds[0].path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!picked || !targetId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.importSave(targetId, picked, overwrite);
      setDone(r);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const hint = SOURCE_OPTIONS.find((o) => o.kind === kind)?.hint ?? "";

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[86vh] w-160 max-w-full flex-col gap-3 overflow-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiDownload className="size-5 text-pal" /> {t("匯入存檔")}
          </h2>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>

        {done ? (
          <div className="flex flex-col gap-3">
            <p className="inline-flex items-center gap-2 text-[15px] font-bold text-grass">
              <FiCheck className="size-5" /> {t("已匯入世界 {guid} 並設為啟用世界", { guid: done.worldGuid })}
            </p>
            {done.backedUp && (
              <p className="text-[13px] text-ink-muted">{t("原本的存檔已自動備份,可在「存檔備份」分頁還原。")}</p>
            )}
            {pickedWorld?.coopHost && (
              <p className={`${errorCls} flex items-start gap-2`}>
                <FiAlertTriangle className="mt-0.5 size-4 shrink-0" />
                {t("這是本機共玩存檔:主機玩家的角色還需要用 palworld-host-save-fix 轉換(見 FAQ 的遷移指南),否則該玩家進伺服器會被要求重建角色。")}
              </p>
            )}
            <p className="text-[13px] text-ink-muted">{t("啟動伺服器後,玩家用原本的角色進來即可。")}</p>
            <button className={`${btn} self-start`} onClick={onClose}>
              {t("完成")}
            </button>
          </div>
        ) : (
          <>
            {eligible.length === 0 ? (
              <p className="text-[13px] text-ink-muted">
                {t("還沒有可匯入的實例 — 先按「建立伺服器」建立一個(k8s 實例請用模組分頁的檔案上傳)。")}
              </p>
            ) : (
              <>
                {/* 來源類型 */}
                <div className="flex flex-wrap gap-2">
                  {SOURCE_OPTIONS.map((o) => (
                    <button
                      key={o.kind}
                      type="button"
                      className={`rounded-(--radius-cute) border-2 px-3 py-1.5 text-[13px] font-bold transition ${
                        kind === o.kind ? "border-pal bg-pal/10 text-pal" : "border-line text-ink-muted hover:border-ink-muted"
                      }`}
                      onClick={() => setKind(o.kind)}
                    >
                      {t(o.label)}
                    </button>
                  ))}
                </div>
                <p className="text-[13px] leading-relaxed text-ink-muted">{t(hint)}</p>

                {/* 來源路徑 + 掃描 */}
                <div className="flex gap-2">
                  <input
                    className={`${inputCls} flex-1`}
                    placeholder={t("貼上存檔所在的資料夾路徑(在跑 agent 的那台機器上)")}
                    value={sourcePath}
                    onChange={(e) => setSourcePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && sourcePath.trim()) void scan();
                    }}
                  />
                  <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={scan} disabled={busy || !sourcePath.trim()}>
                    <FiSearch className="size-4" /> {t("掃描")}
                  </button>
                </div>

                {/* 掃描結果 */}
                {worlds !== null && worlds.length === 0 && (
                  <p className="text-[13px] text-ink-muted">
                    {t("這個路徑下沒有找到世界存檔(含 Level.sav 的資料夾)。確認路徑指向存檔資料夾或其上層目錄。")}
                  </p>
                )}
                {worlds !== null && worlds.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {worlds.map((w) => (
                      <label
                        key={w.path}
                        className={`flex cursor-pointer items-center gap-3 rounded-(--radius-cute) border-2 px-3 py-2 transition ${
                          picked === w.path ? "border-pal bg-pal/5" : "border-line hover:border-ink-muted"
                        }`}
                      >
                        <input type="radio" name="world" checked={picked === w.path} onChange={() => setPicked(w.path)} />
                        <span className="flex-1">
                          <span className="block font-mono text-[13px] font-bold">{w.guid}</span>
                          <span className="block text-xs text-ink-muted">
                            {w.sizeMB} MB · {t("{n} 位玩家", { n: w.players })} · {new Date(w.lastModified).toLocaleString()}
                          </span>
                        </span>
                        {w.coopHost && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-600">
                            <FiAlertTriangle className="size-3" /> {t("需修正主機角色")}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                )}

                {/* 目標實例 */}
                <label className="flex flex-col gap-1.5 text-[13px] font-bold text-ink-muted">
                  {t("匯入到哪個實例")}
                  <select className={inputCls} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                    {eligible.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </label>
                {targetRunning && (
                  <p className={errorCls}>{t("目標實例正在運行 — 請先停止伺服器再匯入。")}</p>
                )}

                <label className="inline-flex items-center gap-2 text-[13px] font-bold text-ink-muted">
                  <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                  {t("覆蓋同名世界(匯入前會自動備份現有存檔)")}
                </label>

                {error && <p className={errorCls}>{error}</p>}

                <div className="flex gap-2">
                  <button
                    className={`${btn} inline-flex items-center gap-1.5`}
                    onClick={doImport}
                    disabled={busy || !picked || !targetId || targetRunning}
                  >
                    <FiDownload className="size-4" /> {busy ? t("匯入中…") : t("匯入")}
                  </button>
                  <button className={btnGhost} onClick={onClose} disabled={busy}>
                    {t("取消")}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Overlay>
  );
}
