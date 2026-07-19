import { useCallback, useEffect, useState } from "react";
import { FiChevronRight, FiFolder, FiFolderPlus, FiRefreshCw, FiArrowUpCircle, FiX } from "react-icons/fi";
import type { DirEntry } from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card, errorCls, inputCls } from "./ui";

/** 路徑分隔符:偵測是 Windows 風格(\\) 還是 Unix 風格(/)。 */
function sepOf(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

/** 絕對路徑的 parent。Windows 上從 C:\Users 回到 C:\，從 C:\ 回到 ""（磁碟機列表）。 */
function parentDir(p: string): string {
  const s = sepOf(p);
  const clean = p.replace(/[/\\]$/, "");
  const parts = clean.split(/[/\\]+/);
  if (parts.length <= 1) return ""; // 根目錄或磁碟機 → 回到最上層
  const up = parts.slice(0, -1).join(s);
  // Windows: 如果 parent 只剩磁碟代號(如 C:)，補上反斜線
  return /^[A-Za-z]:$/.test(up) ? up + "\\" : up;
}

/** 讓使用者在 agent 主機上瀏覽目錄、選取一個資料夾路徑。 */
export function DirectoryPicker({
  client,
  initialPath = "",
  onSelect,
  onClose,
}: {
  client: AgentClient;
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  useI18n();
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualPath, setManualPath] = useState("");

  const refresh = useCallback(async (path: string) => {
    setError(null);
    setEntries(null);
    setBusy(true);
    try {
      const res = await client.hostListDir(path);
      setCurrentPath(res.path);
      setEntries(res.entries);
      setManualPath(res.path);
    } catch (err) {
      setEntries([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [client]);

  useEffect(() => {
    if (initialPath) void refresh(initialPath);
    else void refresh("");
  }, []); // only on mount

  const isWin =
    currentPath.includes("\\") || /^[A-Za-z]:/.test(currentPath);

  const goUp = () => {
    if (!currentPath) return; // 已在最上層
    const parent = parentDir(currentPath);
    void refresh(parent);
  };

  const goTo = (name: string) => {
    if (!currentPath) {
      // 從磁碟機列表進入
      void refresh(name);
    } else {
      const s = sepOf(currentPath);
      const next = currentPath.replace(/[/\\]$/, "") + s + name;
      void refresh(next);
    }
  };

  const handleManualGo = () => {
    if (manualPath.trim()) void refresh(manualPath.trim());
  };

  const handleNewFolder = async () => {
    if (!currentPath) return;
    const name = prompt(t("新資料夾名稱"));
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const s = sepOf(currentPath);
      const fullPath = currentPath.replace(/[/\\]$/, "") + s + name.trim();
      await client.hostMkdir(fullPath);
      await refresh(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const segments = currentPath
    ? currentPath
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/\/$/, "")
        .split("/")
    : [];

  return (
    <div
      className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-[rgb(35_32_48/0.55)] p-6 backdrop-blur-[3px]"
      onClick={onClose}
    >
      <div
        className={`${card} my-auto flex max-h-[90vh] w-[600px] max-w-full flex-col gap-3 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiFolder className="size-5 text-pal" /> {t("選擇資料夾")}
          </h2>
          <button className={btnGhost} onClick={onClose}>
            {t("關閉")}
          </button>
        </div>

        {/* 手動輸入/顯示路徑 */}
        <div className="flex gap-2">
          <input
            className={`${inputCls} flex-1 font-mono text-xs`}
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleManualGo();
            }}
            placeholder={t("絕對路徑，或留空顯示根目錄")}
          />
          <button
            type="button"
            className={`${btnGhost} inline-flex items-center gap-1.5 px-3`}
            onClick={handleManualGo}
            disabled={busy}
            title={t("前往")}
          >
            <FiChevronRight className="size-4" />
          </button>
        </div>

        {/* 麵包屑導航 */}
        <nav className="flex flex-wrap items-center gap-1 text-[13px] font-bold">
          {!currentPath ? (
            <span className="flex items-center gap-1 text-ink">
              <FiFolder className="size-3.5" />
              <span>{isWin ? t("本機") : "/"}</span>
            </span>
          ) : (
            <>
              <button className="flex items-center gap-1 text-pal hover:underline" onClick={goUp} title={t("上一層")}>
                <FiArrowUpCircle className="size-4" />
              </button>
              {segments.map((seg, i) => (
                <span key={i} className="flex items-center gap-1">
                  <FiChevronRight className="size-3.5 text-ink-muted" />
                  <button
                    className={
                      i === segments.length - 1 ? "text-ink" : "text-pal hover:underline"
                    }
                    onClick={() => {
                      if (i < segments.length - 1) {
                        let up = segments.slice(0, i + 1).join("/");
                        // Windows: 轉換 C: 成 C:\
                        if (isWin) up = up.replace(/^([A-Za-z]):$/, "$1:\\");
                        void refresh(up);
                      }
                    }}
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </>
          )}
        </nav>

        {/* 錯誤 */}
        {error && <p className={errorCls}>{error}</p>}

        {/* 目錄列表 */}
        <div className={`${card} max-h-[50vh] overflow-y-auto p-0`}>
          {entries === null ? (
            <p className="p-5 text-[13px] text-ink-muted">{t("載入中…")}</p>
          ) : entries.filter((e) => e.isDir).length === 0 ? (
            <p className="p-5 text-[13px] text-ink-muted">{t("這個資料夾沒有子資料夾。")}</p>
          ) : (
            <div className="flex flex-col divide-y divide-line">
              {entries
                .filter((e) => e.isDir)
                .map((entry) => (
                  <button
                    key={entry.name}
                    className="flex items-center gap-3 px-4 py-2.5 text-left transition hover:bg-card-soft"
                    onClick={() => goTo(entry.name)}
                  >
                    <FiFolder className="size-4 shrink-0 text-pal" />
                    <span className="flex-1 truncate text-sm font-bold">{entry.name}</span>
                    <span className="text-xs text-ink-muted">{t("資料夾")}</span>
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* 選取按鈕 */}
        <div className="flex gap-2">
          <button
            className={`${btn} flex-1`}
            onClick={() => onSelect(currentPath)}
            disabled={busy || !!error}
          >
            {t("選取此資料夾")}
          </button>
          <button
            type="button"
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => onSelect("")}
            disabled={busy}
            title={t("清除選擇，使用 agent 預設目錄")}
          >
            <FiX className="size-4" /> {t("清除")}
          </button>
          {currentPath && (
            <button
              type="button"
              className={`${btnGhost} inline-flex items-center gap-1.5`}
              onClick={handleNewFolder}
              disabled={busy}
              title={t("在當前目錄建立新資料夾")}
            >
              <FiFolderPlus className="size-4" /> {t("新資料夾")}
            </button>
          )}
          <button
            type="button"
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => void refresh(currentPath)}
            disabled={busy}
          >
            <FiRefreshCw className="size-4" /> {t("重新整理")}
          </button>
        </div>
      </div>
    </div>
  );
}
