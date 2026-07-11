import { useCallback, useEffect, useRef, useState } from "react";
import { GiSheep, GiEggClutch } from "react-icons/gi";
import { FiDownload, FiHeart, FiHelpCircle, FiPlus, FiSettings, FiAlertTriangle } from "react-icons/fi";
import type { InstanceSummary } from "@palserver/shared";
import { AgentClient, loadConnection, saveConnection, type Connection } from "./api";
import { usePromoConfig } from "./promoConfig";
import { ConnectFlow } from "./ConnectFlow";
import { SettingsModal } from "./SettingsModal";
import { CreditsModal } from "./CreditsModal";
import { InstanceDetailPage } from "./InstanceDetail";
import { Mascot } from "./Mascot";
import { AnnouncementPopup } from "./AnnouncementModal";
import { SiteFooter } from "./SiteFooter";
import { ThemeToggle } from "./theme";
import { LangSelect, useI18n } from "./i18n";
import { Overlay, StatusBadge, btn, btnGhost, card, errorCls, inputCls, labelCls } from "./ui";

export default function App() {
  const [conn, setConn] = useState<Connection | null>(() => {
    // 網址帶 ?setup= 時強制重新配對:忽略可能已過期的舊連線,交給 ConnectFlow
    // 用連結裡的配對碼換一把新 token。否則沿用上次存的連線。
    if (new URLSearchParams(window.location.search).has("setup")) return null;
    return loadConnection();
  });
  return (
    <>
      {!conn ? (
        <ConnectFlow
          onConnect={(c) => {
            saveConnection(c);
            setConn(c);
          }}
        />
      ) : (
        <Shell
          conn={conn}
          onDisconnect={() => {
            saveConnection(null);
            setConn(null);
          }}
        />
      )}
      <SiteFooter />
    </>
  );
}

function Shell({ conn, onDisconnect }: { conn: Connection; onDisconnect: () => void }) {
  // 把 onDisconnect 當作 401 處理:token 失效(換過/重置)時自動清掉連線、退回
  // 連線畫面重新配對,而不是一直用壞掉的 token 重試。
  const { t } = useI18n();
  const { faq } = usePromoConfig();
  const client = useRef(new AgentClient(conn, onDisconnect)).current;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCredits, setShowCredits] = useState(false);

  return (
    // data-content-root:左下角的 SiteFooter 靠它判斷自己有沒有蓋到內容。
    <div data-content-root className="mx-auto max-w-[1200px] p-6">
      <header className="mb-6 flex items-center justify-between">
        <button className="flex items-center gap-2.5" onClick={() => setSelectedId(null)}>
          <img src="/logo.png" alt="" className="size-10 rounded-xl" />
          <h1 className="text-[22px] font-extrabold tracking-wide">palserver GUI</h1>
        </button>
        <div className="flex items-center gap-2.5">
          <span className="hidden text-[13px] text-ink-muted sm:inline">{conn.url}</span>
          <LangSelect />
          <ThemeToggle />
          <a
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            href={faq}
            target="_blank"
            rel="noreferrer"
          >
            <FiHelpCircle className="size-4" /> {t("常見問題")}
          </a>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setShowCredits(true)}
            data-testid="open-credits"
          >
            <FiHeart className="size-4" /> {t("感謝名單")}
          </button>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setShowSettings(true)}
            data-testid="open-settings"
          >
            <FiSettings className="size-4" /> {t("設定")}
          </button>
          <button className={btnGhost} onClick={onDisconnect}>
            {t("中斷連線")}
          </button>
        </div>
      </header>
      {showSettings && (
        <SettingsModal client={client} conn={conn} onClose={() => setShowSettings(false)} />
      )}
      {showCredits && <CreditsModal onClose={() => setShowCredits(false)} />}
      {selectedId ? (
        <InstanceDetailPage
          client={client}
          instanceId={selectedId}
          onBack={() => setSelectedId(null)}
          onDeleted={() => setSelectedId(null)}
        />
      ) : (
        <Dashboard client={client} onOpen={(id) => setSelectedId(id)} />
      )}
    </div>
  );
}

function Dashboard({ client, onOpen }: { client: AgentClient; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const [instances, setInstances] = useState<InstanceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setInstances(await client.listInstances());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <Mascot />
      <AnnouncementPopup />
      {error && <p className={errorCls}>{error}</p>}
      <div className="flex items-center justify-between">
        <h2 className="my-3.5 text-[17px] font-extrabold">{t("伺服器")}</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5`}
          onClick={() => setShowCreate(true)}
          data-testid="create-server"
        >
          <FiPlus className="size-4" /> {t("建立伺服器")}
        </button>
      </div>
      {instances === null ? (
        <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-12 text-center text-ink-muted">
          <GiEggClutch className="mx-auto mb-2 size-11 animate-bounce" />
          {t("載入中…")}
        </div>
      ) : instances.length === 0 ? (
        <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-12 text-center text-ink-muted">
          <GiSheep className="mx-auto mb-2 size-11" />
          {t("還沒有伺服器,建立第一個吧!")}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3.5">
          {instances.map((inst) => (
            <button
              className={`${card} text-left transition hover:-translate-y-0.5 hover:shadow-(--shadow-cute-hover)`}
              key={inst.id}
              onClick={() => onOpen(inst.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <strong className="text-base font-extrabold">{inst.name}</strong>
                <StatusBadge status={inst.status} />
              </div>
              <p className="mt-1 text-[13px] text-ink-muted">
                {inst.enhancements.length > 0 ? t("強化") : t("原味")} · UDP {inst.gamePort}
                {inst.gameVersion && ` · ${inst.gameVersion}`}
              </p>
              {inst.updateAvailable && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-sun/40 bg-sun/15 px-2.5 py-1 text-xs font-bold text-sun">
                  <FiDownload className="size-3.5" /> {t("有新版本可更新")}
                </p>
              )}
              {inst.installError && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-berry/40 bg-berry/10 px-2.5 py-1 text-xs font-bold text-berry">
                  <FiAlertTriangle className="size-3.5" /> {t("安裝失敗")}
                </p>
              )}
            </button>
          ))}
        </div>
      )}
      {showCreate && (
        <CreateDialog
          client={client}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function CreateDialog({
  client,
  onClose,
  onCreated,
}: {
  client: AgentClient;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [backend, setBackend] = useState<"native" | "docker">("native");
  const [serverDir, setServerDir] = useState("");
  const [gamePort, setGamePort] = useState(8211);
  const [maxPlayers, setMaxPlayers] = useState(32);
  const [serverPassword, setServerPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState<string | null>(null);
  const isMac = platform === "darwin";

  // agent 在 macOS 時,主機無法實際執行 Palworld 伺服器(SteamCMD 32-bit 在
  // Rosetta 下不可用、PalServer 存檔即崩潰),不論 native 或 Docker 都一樣。
  useEffect(() => {
    client.info().then((i) => setPlatform(i.platform)).catch(() => {});
  }, [client]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.createInstance({
        name,
        backend,
        flavor: "vanilla",
        gamePort,
        serverDir: backend === "native" && serverDir.trim() ? serverDir.trim() : undefined,
        settings: { ServerPlayerMaxNum: maxPlayers, ServerPassword: serverPassword },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <form
        className={`${card} flex w-[430px] max-w-full flex-col gap-3`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
          <GiEggClutch className="size-5 text-pal" /> {t("建立伺服器")}
        </h2>
        {isMac && (
          <p className="rounded-xl border-2 border-sun/40 bg-sun/10 px-3 py-2 text-xs text-sun">
            {t("這台 agent 執行在 macOS 上,")}<b>{t("無法實際執行 Palworld 伺服器")}</b>
            {t("(SteamCMD/PalServer 在 macOS 不支援)。請把 agent 裝在 Windows 或 Linux 主機上;這裡僅供開發或管理遠端主機。")}
          </p>
        )}
        <label className={labelCls}>
          {t("名稱")}
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("例:我的帕魯伺服器")}
            maxLength={40}
            required
          />
        </label>
        <label className={labelCls}>
          {t("運行方式")}
          <select
            className={inputCls}
            value={backend}
            onChange={(e) => setBackend(e.target.value as "native" | "docker")}
          >
            <option value="native">{t("原生(直接在這台主機上運行,推薦)")}</option>
            <option value="docker">{t("Docker 容器(beta)")}</option>
          </select>
        </label>
        {backend === "native" && (
          <label className={labelCls}>
            {t("伺服器路徑(選填)")}
            <input
              className={inputCls}
              value={serverDir}
              onChange={(e) => setServerDir(e.target.value)}
              placeholder={
                platform === "win32"
                  ? t("例:{path}", { path: "D:\\palworld\\my-server" })
                  : t("例:{path}", { path: "/opt/palworld/my-server" })
              }
            />
            <span className="text-xs font-normal opacity-70">
              {t("留空 = 安裝到 agent 資料夾。填既有 PalServer 安裝目錄會直接採用;填空資料夾或新路徑則會下載安裝到那裡。")}
            </span>
          </label>
        )}
        <label className={labelCls}>
          {t("遊戲埠(UDP)")}
          <input
            className={inputCls}
            type="number"
            value={gamePort}
            onChange={(e) => setGamePort(Number(e.target.value))}
          />
        </label>
        <label className={labelCls}>
          {t("最大玩家數")}
          <input
            className={inputCls}
            type="number"
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(Number(e.target.value))}
            min={1}
            max={32}
          />
        </label>
        <label className={labelCls}>
          {t("伺服器密碼(選填)")}
          <input
            className={inputCls}
            value={serverPassword}
            onChange={(e) => setServerPassword(e.target.value)}
          />
        </label>
        {backend === "native" && (
          <p className="inline-flex items-start gap-2 rounded-xl border-2 border-pal/30 bg-pal/5 px-3 py-2 text-xs text-ink-muted">
            <FiDownload className="mt-0.5 size-4 shrink-0 text-pal" />
            <span>
              {t("首次安裝會下載 Palworld 伺服器檔案,")}
              <b className="text-ink">{t("容量很大(數十 GB)")}</b>
              {t(",需要一段時間,請耐心等候 —— 建立後可在")}
              <b className="text-ink">{t("日誌")}</b>
              {t("分頁看安裝進度。(填既有安裝目錄則會直接採用、跳過下載。)")}
            </span>
          </p>
        )}
        {error && <p className={errorCls}>{t(error)}</p>}
        <div className="mt-1 flex gap-2">
          <button className={btn} disabled={busy}>
            {busy ? t("建立中…") : t("建立")}
          </button>
          <button type="button" className={btnGhost} onClick={onClose}>
            {t("取消")}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
