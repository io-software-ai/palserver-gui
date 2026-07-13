import { useCallback, useEffect, useRef, useState } from "react";
import {
  FiFolder,
  FiFile,
  FiUpload,
  FiTrash2,
  FiFolderPlus,
  FiEdit2,
  FiChevronRight,
  FiRefreshCw,
} from "react-icons/fi";
import type { DirEntry } from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card, errorCls, inputCls } from "./ui";

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

const fmtSize = (n: number) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

/** Browse / edit / upload / delete files inside the instance's server dir. */
export function FileManager({
  client,
  instanceId,
  initialPath = "",
}: {
  client: AgentClient;
  instanceId: string;
  initialPath?: string;
}) {
  useI18n();
  const [dir, setDir] = useState(initialPath);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await client.listFiles(instanceId, dir);
      setEntries(res.entries);
      setError(null);
    } catch (err) {
      setEntries([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId, dir]);

  useEffect(() => {
    setEntries(null); // don't show the previous directory's entries while loading
    void refresh();
  }, [refresh]);

  const remove = async (entry: DirEntry) => {
    const what = entry.isDir ? t("資料夾(含所有內容)") : t("檔案");
    if (!confirm(t("確定要刪除{what}「{name}」嗎?此動作無法復原。", { what, name: entry.name }))) return;
    setBusy(true);
    try {
      await client.deleteFile(instanceId, joinPath(dir, entry.name));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(fileList)) {
        await client.uploadFile(instanceId, joinPath(dir, file.name), file);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const newFolder = async () => {
    const name = prompt(t("新資料夾名稱"));
    if (!name?.trim()) return;
    setBusy(true);
    try {
      await client.makeDir(instanceId, joinPath(dir, name.trim()));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const segments = dir ? dir.split("/") : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex flex-wrap items-center gap-1 text-[13px] font-bold">
          <button className="text-pal hover:underline" onClick={() => setDir("")}>
            {t("伺服器根目錄")}
          </button>
          {segments.map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              <FiChevronRight className="size-3.5 text-ink-muted" />
              <button
                className={i === segments.length - 1 ? "text-ink" : "text-pal hover:underline"}
                onClick={() => setDir(segments.slice(0, i + 1).join("/"))}
              >
                {seg}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex gap-2">
          <button className={btnGhost} onClick={refresh} disabled={busy} aria-label={t("重新整理")}>
            <FiRefreshCw className="size-4" />
          </button>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={newFolder}
            disabled={busy}
          >
            <FiFolderPlus className="size-4" /> {t("新資料夾")}
          </button>
          <button
            className={`${btn} inline-flex items-center gap-1.5`}
            onClick={() => uploadRef.current?.click()}
            disabled={busy}
          >
            <FiUpload className="size-4" /> {busy ? t("處理中…") : t("上傳檔案")}
          </button>
          <input
            ref={uploadRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => upload(e.target.files)}
          />
        </div>
      </div>

      {error && <p className={errorCls}>{error}</p>}

      <div className={`${card} p-0`}>
        {entries === null ? (
          <p className="p-5 text-[13px] text-ink-muted">{t("載入中…")}</p>
        ) : entries.length === 0 ? (
          <p className="p-5 text-[13px] text-ink-muted">{t("這個資料夾是空的。")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {entries.map((entry) => (
              <div key={entry.name} className="flex items-center gap-3 px-4 py-2.5">
                {entry.isDir ? (
                  <FiFolder className="size-4 shrink-0 text-pal" />
                ) : (
                  <FiFile className="size-4 shrink-0 text-ink-muted" />
                )}
                <button
                  className={`flex-1 truncate text-left text-sm font-bold ${entry.isDir ? "hover:underline" : ""}`}
                  onClick={() => entry.isDir && setDir(joinPath(dir, entry.name))}
                  disabled={!entry.isDir}
                >
                  {entry.name}
                </button>
                <span className="hidden w-20 shrink-0 text-right text-xs text-ink-muted sm:block">
                  {entry.isDir ? "—" : fmtSize(entry.size)}
                </span>
                <div className="flex shrink-0 gap-1.5">
                  {entry.editable && (
                    <button
                      className="rounded-full border-[1.5px] border-line px-3 py-1 text-xs font-bold text-ink transition hover:border-pal"
                      onClick={() => setEditing(joinPath(dir, entry.name))}
                    >
                      <FiEdit2 className="inline size-3.5" /> {t("編輯")}
                    </button>
                  )}
                  <button
                    className="rounded-full border-[1.5px] border-line px-3 py-1 text-xs font-bold text-berry transition hover:border-berry"
                    onClick={() => remove(entry)}
                    disabled={busy}
                  >
                    <FiTrash2 className="inline size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <FileEditor
          client={client}
          instanceId={instanceId}
          path={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

/** The file manager in a modal, rooted at `initialPath`. */
export function FileBrowserDialog({
  client,
  instanceId,
  initialPath,
  onClose,
}: {
  client: AgentClient;
  instanceId: string;
  initialPath: string;
  onClose: () => void;
}) {
  useI18n();
  return (
    <div
      className="fixed inset-0 flex items-start justify-center overflow-y-auto bg-[rgb(35_32_48/0.55)] p-6 backdrop-blur-[3px]"
      onClick={onClose}
    >
      <div
        className={`${card} my-auto flex max-h-[90vh] w-[860px] max-w-full flex-col gap-3 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold">{t("檔案管理")}</h2>
          <button className={btnGhost} onClick={onClose}>
            {t("關閉")}
          </button>
        </div>
        <FileManager client={client} instanceId={instanceId} initialPath={initialPath} />
      </div>
    </div>
  );
}

/** Full-screen text editor for one config/script file. */
export function FileEditor({
  client,
  instanceId,
  path,
  onClose,
  onSaved,
}: {
  client: AgentClient;
  instanceId: string;
  path: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  useI18n();
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    client
      .readFile(instanceId, path)
      .then((f) => {
        setContent(f.content);
        setOriginal(f.content);
      })
      .catch((err: Error) => setError(err.message));
  }, [client, instanceId, path]);

  const dirty = content !== null && content !== original;

  const save = async () => {
    if (content === null) return;
    setSaving(true);
    setError(null);
    try {
      await client.writeFile(instanceId, path, content);
      setOriginal(content);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (dirty && !confirm(t("有未儲存的變更,確定要關閉嗎?"))) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-[rgb(35_32_48/0.55)] p-6 backdrop-blur-[3px]"
      onClick={close}
    >
      <div
        className={`${card} flex h-[80vh] w-[900px] max-w-full flex-col gap-3`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="truncate text-lg font-extrabold">{path}</h2>
          <div className="flex shrink-0 gap-2">
            <button className={btn} onClick={save} disabled={!dirty || saving || content === null}>
              {saving ? t("儲存中…") : t("儲存")}
            </button>
            <button className={btnGhost} onClick={close}>
              {t("關閉")}
            </button>
          </div>
        </div>
        {error && <p className={errorCls}>{error}</p>}
        {content === null ? (
          <p className="text-[13px] text-ink-muted">{t("載入中…")}</p>
        ) : (
          <textarea
            className={`${inputCls} flex-1 resize-none font-mono text-xs leading-relaxed`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
          />
        )}
        <p className="text-[13px] text-ink-muted">
          {dirty ? t("小心~有變更尚未儲存!") : t("儲存後,重啟伺服器才會生效。")}
        </p>
      </div>
    </div>
  );
}
