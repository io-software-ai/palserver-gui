import { useState } from "react";
import { FiAlertTriangle, FiCopy, FiDownloadCloud, FiFolder, FiHardDrive, FiLayout, FiSave, FiTrash2 } from "react-icons/fi";
import type { InstanceDetail } from "@palserver/shared";
import type { AgentClient } from "./api";
import { CopyPath } from "./CopyPath";
import { FileBrowserDialog } from "./FileManager";
import { LaunchOptionsCard } from "./LaunchOptionsCard";
import { OVERVIEW_CARDS, DISMISSIBLE_WARNINGS, DISMISSIBLE_PROMOS, useHiddenCards } from "./tabPrefs";
import { t, useI18n } from "./i18n";
import { btn, btnDanger, btnGhost, card, errorCls, inputCls, labelCls } from "./ui";

/**
 * 實例的「設定」分頁:目前放伺服器路徑修改與危險操作(刪除)。刻意和「世界設定」
 * (遊戲玩法)、「引擎微調」(效能)分開 —— 這裡是這個實例本身的管理設定。
 */
export function InstanceSettingsTab({
  client,
  detail,
  onChanged,
  onDeleted,
}: {
  client: AgentClient;
  detail: InstanceDetail;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  useI18n();
  // 伺服器運行/安裝中不允許改路徑或刪除,避免行程與檔案狀態改到分家。
  const stopped = detail.status === "exited" || detail.status === "created" || detail.status === "missing";

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <AutoStartCard client={client} detail={detail} />

      <ServerFilesCard client={client} instanceId={detail.id} />

      {detail.backend === "native" && (
        <>
          <ServerPathCard
            client={client}
            instanceId={detail.id}
            serverDir={detail.serverDir}
            effectiveServerDir={detail.effectiveServerDir}
            stopped={stopped}
            onChanged={onChanged}
          />
          <ExportDuplicateCard client={client} detail={detail} stopped={stopped} />
        </>
      )}

      <LaunchOptionsCard client={client} instanceId={detail.id} category="general" />


      <OverviewCardsCard />

      <DangerZone
        client={client}
        instanceId={detail.id}
        name={detail.name}
        adminPassword={String(detail.settings.AdminPassword ?? "")}
        onDeleted={onDeleted}
      />
    </div>
  );
}

/** 伺服器檔案瀏覽器入口(直接編輯 / 上傳 / 刪除伺服器目錄裡的檔案)。 */
function ServerFilesCard({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [browsing, setBrowsing] = useState<string | null>(null);
  return (
    <div className={card}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
          <FiFolder className="size-4 text-pal" /> {t("伺服器檔案")}
        </h3>
        <button
          className={`${btnGhost} inline-flex items-center gap-1.5`}
          onClick={() => setBrowsing("")}
        >
          <FiFolder className="size-4" /> {t("瀏覽全部")}
        </button>
      </div>
      <p className="text-[13px] text-ink-muted">
        {t("直接編輯、上傳或刪除伺服器目錄裡的檔案(例如 PalDefender 的 Config.json)。")}
      </p>
      {browsing !== null && (
        <FileBrowserDialog
          client={client}
          instanceId={instanceId}
          initialPath={browsing}
          onClose={() => setBrowsing(null)}
        />
      )}
    </div>
  );
}

/** 恢復被按叉叉收起的卡片與警告(總覽卡片、各分頁的黃色提醒)。 */
function OverviewCardsCard() {
  useI18n();
  const [hidden, setHidden] = useHiddenCards();
  const toggle = (id: string) =>
    setHidden(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]);

  const section = (title: string, items: { id: string; label: string }[]) => (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] font-bold text-ink-muted">{t(title)}</p>
      {items.map((c) => (
        <label key={c.id} className="inline-flex cursor-pointer items-center gap-2 text-[13px] font-bold">
          <input
            type="checkbox"
            className="size-4 accent-pal"
            checked={!hidden.includes(c.id)}
            onChange={() => toggle(c.id)}
          />
          {t(c.label)}
        </label>
      ))}
    </div>
  );

  return (
    <div className={`${card} flex flex-col gap-3`}>
      <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
        <FiLayout className="size-4 text-pal" /> {t("卡片隱藏")}
      </h3>
      <p className="text-[13px] text-ink-muted">
        {t("取消勾選即可隱藏對應的卡片或提醒;這些也可以直接在畫面上點右上角的 × 收起,再回這裡勾回來。")}
      </p>
      {section("總覽卡片", OVERVIEW_CARDS)}
      {section("提醒訊息", DISMISSIBLE_WARNINGS)}
      {section("推廣", DISMISSIBLE_PROMOS)}
    </div>
  );
}

function ServerPathCard({
  client,
  instanceId,
  serverDir,
  effectiveServerDir,
  stopped,
  onChanged,
}: {
  client: AgentClient;
  instanceId: string;
  serverDir: string | null;
  effectiveServerDir: string | null;
  stopped: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = useState(serverDir ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const managed = serverDir === null;
  const dirty = value.trim() !== (serverDir ?? "");

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await client.updateServerDir(instanceId, value.trim());
      // moving=true 代表跨磁碟搬移在背景進行,狀態會短暫顯示「安裝中」。
      setNotice(
        res.moving
          ? t("正在背景搬移伺服器檔案,完成前狀態會顯示為「安裝中」…")
          : t("已搬移伺服器檔案到新位置。"),
      );
      setTimeout(() => setNotice(null), res.moving ? 6000 : 3000);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={`${card} flex flex-col gap-3`} onSubmit={save}>
      <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
        <FiHardDrive className="size-4 text-pal" /> {t("伺服器路徑")}
      </h3>

      <div>
        <p className="mb-1 text-xs font-bold text-ink-muted">{t("目前路徑")}</p>
        {effectiveServerDir ? (
          <CopyPath
            value={effectiveServerDir}
            secret
            className="w-full rounded-lg border-2 border-line bg-card-soft px-3 py-2 font-mono text-[13px]"
          />
        ) : (
          <span className="text-[13px] text-ink-muted">{t("agent 管理")}</span>
        )}
      </div>

      <label className={labelCls}>
        {t("搬移到(絕對路徑;留空 = 搬回 agent 管理的資料夾)")}
        <input
          className={`${inputCls} font-mono`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("例:{path}", { path: "D:\\palworld\\my-server" })}
          disabled={!stopped}
        />
      </label>

      <p className="rounded-xl bg-card-soft px-3 py-2 text-xs text-ink-muted">
        {managed
          ? t("這個路徑由 agent 自動管理。")
          : t("你指定的伺服器安裝目錄。")}{" "}
        {t("儲存後會把現有的伺服器檔案實際搬到新位置。目標需為空資料夾或不存在的路徑;同磁碟搬移很快,跨磁碟(例如 C 槽搬到 D 槽)需要複製、檔案多時較久。")}
      </p>

      {!stopped && (
        <p className="rounded-xl bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
          {t("請先停止伺服器再搬移路徑。")}
        </p>
      )}
      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}

      <div>
        <button className={`${btn} inline-flex items-center gap-1.5`} disabled={!stopped || !dirty || busy}>
          <FiSave className="size-4" /> {busy ? t("搬移中…") : t("搬移到這個路徑")}
        </button>
      </div>
    </form>
  );
}

/** 匯出成壓縮檔(存檔+設定,不含遊戲執行檔)、複製成新實例。 */
function ExportDuplicateCard({
  client,
  detail,
  stopped,
}: {
  client: AgentClient;
  detail: InstanceDetail;
  stopped: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dupName, setDupName] = useState(`${detail.name}-copy`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const duplicate = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await client.duplicateInstance(detail.id, dupName.trim() || undefined);
      setNotice(
        t("已複製為「{name}」(遊戲埠 {port}),可在伺服器列表找到它。", {
          name: created.name,
          port: created.gamePort,
        }),
      );
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${card} flex flex-col gap-4`}>
      <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
        <FiDownloadCloud className="size-4 text-pal" /> {t("匯出與複製")}
      </h3>

      {/* 匯出 */}
      <div className="flex flex-col gap-2">
        <p className="text-[13px] text-ink-muted">
          {t("把世界存檔與設定打包成壓縮檔下載。")}
          <b className="text-ink">{t("不含可重新下載的遊戲檔案")}</b>
          {t(",所以檔案小、方便搬到別台。")}
        </p>
        <div>
          {/* 直接下載:GET + token 走 query。download 屬性讓瀏覽器存檔而非開新分頁。 */}
          <a className={`${btnGhost} inline-flex items-center gap-1.5`} href={client.exportUrl(detail.id)} download>
            <FiDownloadCloud className="size-4" /> {t("匯出成壓縮檔")}
          </a>
        </div>
      </div>

      {/* 複製 */}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <p className="text-[13px] text-ink-muted">
          {t("用相同設定與世界存檔開一個新伺服器(自動換新名稱與遊戲埠)。同樣不含遊戲檔案,新伺服器首次啟動會自行安裝。")}
        </p>
        {!open ? (
          <div>
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5`}
              onClick={() => {
                setOpen(true);
                setNotice(null);
              }}
              disabled={!stopped}
              title={stopped ? undefined : t("請先停止伺服器")}
            >
              <FiCopy className="size-4" /> {t("複製伺服器")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl border-2 border-line bg-card-soft p-3">
            <label className={labelCls}>
              {t("新伺服器名稱")}
              <input
                className={inputCls}
                value={dupName}
                onChange={(e) => setDupName(e.target.value)}
                autoFocus
              />
            </label>
            <div className="flex gap-2">
              <button
                className={`${btn} inline-flex items-center gap-1.5`}
                onClick={duplicate}
                disabled={busy || !dupName.trim()}
              >
                <FiCopy className="size-4" /> {busy ? t("複製中…") : t("建立複本")}
              </button>
              <button
                className="rounded-full px-4 py-2 text-sm font-extrabold text-ink-muted hover:text-ink"
                onClick={() => setOpen(false)}
              >
                {t("取消")}
              </button>
            </div>
          </div>
        )}
        {!stopped && (
          <p className="rounded-xl bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
            {t("請先停止伺服器再複製,才能得到乾淨的存檔複本。")}
          </p>
        )}
      </div>

      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}
    </div>
  );
}

/** 刪除:必須輸入伺服器名稱與管理員密碼才放行,避免手滑刪掉整台伺服器。 */
function DangerZone({
  client,
  instanceId,
  name,
  adminPassword,
  onDeleted,
}: {
  client: AgentClient;
  instanceId: string;
  name: string;
  adminPassword: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [pwInput, setPwInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameOk = nameInput === name;
  const pwOk = pwInput === adminPassword;
  const canDelete = nameOk && pwOk && !busy;

  const del = async () => {
    if (!canDelete) return;
    setBusy(true);
    setError(null);
    try {
      await client.deleteInstance(instanceId);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className={`${card} flex flex-col gap-3 border-berry/40`}>
      <h3 className="inline-flex items-center gap-2 text-sm font-extrabold text-berry">
        <FiAlertTriangle className="size-4" /> {t("刪除伺服器")}
      </h3>
      <p className="text-[13px] text-ink-muted">
        {t("移除這個伺服器實例,")}
        <b className="text-berry">{t("世界存檔會一併永久刪除")}</b>
        {t("。此動作無法復原。")}
      </p>
      <p className="text-xs text-ink-muted">
        {t("(若伺服器檔案位於你自行指定的外部目錄,該目錄會保留。)")}
      </p>

      {!open ? (
        <div>
          <button
            className={`${btnDanger} inline-flex items-center gap-1.5`}
            onClick={() => setOpen(true)}
          >
            <FiTrash2 className="size-4" /> {t("刪除此伺服器…")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border-2 border-berry/30 bg-berry/5 p-3">
          <p className="text-[13px] font-bold text-ink">
            {t("為確認,請輸入伺服器名稱與管理員密碼。")}
          </p>
          <label className={labelCls}>
            {t("伺服器名稱")}
            <input
              className={inputCls}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={name}
              autoComplete="off"
            />
          </label>
          <label className={labelCls}>
            {t("管理員密碼")}
            <input
              className={inputCls}
              type="password"
              value={pwInput}
              onChange={(e) => setPwInput(e.target.value)}
              autoComplete="off"
            />
            {adminPassword === "" && (
              <span className="text-xs font-normal text-ink-muted">
                {t("此伺服器未設定管理員密碼,密碼欄留空即可。")}
              </span>
            )}
          </label>
          {error && <p className={errorCls}>{error}</p>}
          <div className="flex gap-2">
            <button
              className={`${btnDanger} inline-flex items-center gap-1.5`}
              onClick={del}
              disabled={!canDelete}
            >
              <FiTrash2 className="size-4" /> {busy ? t("刪除中…") : t("永久刪除")}
            </button>
            <button
              className="rounded-full px-4 py-2 text-sm font-extrabold text-ink-muted hover:text-ink"
              onClick={() => {
                setOpen(false);
                setNameInput("");
                setPwInput("");
                setError(null);
              }}
            >
              {t("取消")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


/** agent 啟動時自動開服的開關。搭配全域設定的「開機自動啟動 agent」= 主機開機即開服。 */
function AutoStartCard({ client, detail }: { client: AgentClient; detail: InstanceDetail }) {
  useI18n();
  const [on, setOn] = useState(detail.autoStart ?? false);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const r = await client.setAutoStart(detail.id, !on);
      setOn(r.autoStart);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
      <div className="min-w-0">
        <h3 className="text-sm font-extrabold">{t("自動啟動")}</h3>
        <p className="mt-0.5 text-xs text-ink-muted">
          {t("agent 啟動時自動開這台伺服器。搭配「設定 → 系統 → 開機自動啟動 agent」,主機開機就會自動開服。")}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy}
        onClick={() => void toggle()}
        className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? "bg-grass" : "bg-line"}`}
      >
        <span className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${on ? "left-6" : "left-1"}`} />
      </button>
    </div>
  );
}
