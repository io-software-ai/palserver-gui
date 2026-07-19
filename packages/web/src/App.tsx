import { useCallback, useEffect, useRef, useState } from "react";
import { GiSheep, GiEggClutch } from "react-icons/gi";
import { FiActivity, FiAlertTriangle, FiClock, FiCpu, FiDownload, FiFolder, FiHardDrive, FiHeart, FiHelpCircle, FiPlus, FiServer, FiSettings, FiStar, FiUsers, FiZap } from "react-icons/fi";
import { hasFeature } from "@palserver/shared";
import type { Backend, ExternalWorldCandidate, InstanceStats, InstanceSummary, LiveStatus } from "@palserver/shared";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  arrayMove,
  useSortable,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AgentClient, loadConnection, saveConnection, type Connection } from "./api";
import { usePromoConfig } from "./promoConfig";
import { MapTab } from "./MapTab";
import { ConnectFlow } from "./ConnectFlow";
import { SettingsModal } from "./SettingsModal";
import { SystemReviewCard } from "./SystemReviewCard";
import { CreditsModal } from "./CreditsModal";
import { InstanceDetailPage } from "./InstanceDetail";
import { Mascot } from "./Mascot";
import { DirectoryPicker } from "./DirectoryPicker";
import { AnnouncementPopup } from "./AnnouncementModal";
import { ImportSaveModal } from "./ImportSaveModal";
import { OPEN_SETTINGS_EVENT, SiteFooter } from "./SiteFooter";
import { ThemeToggle } from "./theme";
import { LangSelect, useI18n, t as translate } from "./i18n";
import { fmtBytes, fmtDuration, knownCpuSample } from "./PerformanceTab";
import { WORLD_PRESETS, type WorldPreset } from "@palserver/shared";
import { EmptyState, InstallProgress, Overlay, Select, StatusBadge, btn, btnGhost, card, errorCls, inputCls, labelCls } from "./ui";

export default function App() {
  // 全螢幕地圖是前端的另一個入口(/map?instance=<id>),從主介面地圖的外連按鈕開新分頁。
  // 這裡在最前面攔截,直接渲染獨立的地圖頁,不套主介面的外殼。
  if (window.location.pathname.replace(/\/+$/, "") === "/map") return <MapPage />;

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
      <SiteFooter conn={conn} />
    </>
  );
}
/** 全螢幕地圖獨立頁(/map?instance=<id>)。沿用主介面存下的連線,直接把某個實例的
 *  線上地圖鋪滿整個視窗;沒有連線或沒帶 instance 時提示回主介面開啟。 */
function MapPage() {
  const { t } = useI18n();
  const conn = loadConnection();
  const instanceId = new URLSearchParams(window.location.search).get("instance");
  const client = useRef<AgentClient | null>(conn ? new AgentClient(conn, () => {}) : null).current;

  if (!client || !instanceId) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-extrabold">{t("無法載入地圖")}</p>
        <p className="text-[13px] text-ink-muted">{t("請從主介面的線上地圖開啟全螢幕地圖。")}</p>
        <a className={btn} href="/">{t("回主介面")}</a>
      </div>
    );
  }
  return <MapTab client={client} instanceId={instanceId} fullscreen />;
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

  // 左下角「有新版本」小提醒點下去 → 打開設定視窗(裡頭有 GUI 更新區塊)。
  useEffect(() => {
    const open = () => setShowSettings(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open);
  }, []);

  return (
    // data-content-root:左下角的 SiteFooter 靠它判斷自己有沒有蓋到內容。
    <div data-content-root className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-2.5">
        <button className="flex items-center gap-2.5" onClick={() => setSelectedId(null)}>
          <img src="/logo.png" alt="" className="size-9 rounded-xl sm:size-10" />
          <h1 className="text-lg font-extrabold tracking-wide sm:text-[22px]">palserver GUI</h1>
        </button>
        <div className="flex flex-wrap items-center gap-2.5">
          <LangSelect />
          <ThemeToggle />
          <a
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            href={faq}
            target="_blank"
            rel="noreferrer"
            title={t("常見問題")}
          >
            <FiHelpCircle className="size-4" /> <span className="hidden sm:inline">{t("常見問題")}</span>
          </a>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setShowCredits(true)}
            data-testid="open-credits"
            title={t("感謝名單")}
          >
            <FiHeart className="size-4" /> <span className="hidden sm:inline">{t("感謝名單")}</span>
          </button>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setShowSettings(true)}
            data-testid="open-settings"
            title={t("設定")}
          >
            <FiSettings className="size-4" /> <span className="hidden sm:inline">{t("設定")}</span>
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

// 首頁伺服器卡片的自訂排序(使用者拖曳後存 localStorage;新建的伺服器排在最後)。
const ORDER_KEY = "palserver.instanceOrder";
function loadInstanceOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}
function saveInstanceOrder(ids: string[]): void {
  localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
}
/** 依儲存的順序排列;不在順序表裡的(新伺服器)沿用原本順序排在後面。 */
function sortByOrder(list: InstanceSummary[], order: string[]): InstanceSummary[] {
  const rank = new Map(order.map((id, i) => [id, i] as const));
  return [...list].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

// 首頁「進階顯示」開關(運作中的卡片直接顯示玩家數/CPU/記憶體/FPS)。
const ADVANCED_KEY = "palserver.dashboardAdvanced";
/** 進階顯示時每張運作中卡片的即時資料(stats 一定拿得到;REST 未啟用時 live 為 null)。 */
interface CardExtra {
  stats: InstanceStats | null;
  live: LiveStatus | null;
}

function Dashboard({ client, onOpen }: { client: AgentClient; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const [instances, setInstances] = useState<InstanceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // 匯入存檔流程選定的世界:帶著它開「建立伺服器」對話框,建立後自動匯入。
  const [pendingImport, setPendingImport] = useState<ExternalWorldCandidate | null>(null);
  const [order, setOrder] = useState<string[]>(loadInstanceOrder);
  const [advanced, setAdvanced] = useState(() => localStorage.getItem(ADVANCED_KEY) === "1");
  const [listSearch, setListSearch] = useState("");
  const [showReview, setShowReview] = useState(false); // 配置評估健檢彈窗
  const [extras, setExtras] = useState<Record<string, CardExtra>>({});
  // 進階顯示是贊助者先行功能(dashboard-stats),與其他早鳥功能同一套判斷。
  const [entitled, setEntitled] = useState(false);
  const toggleAdvanced = () =>
    setAdvanced((v) => {
      localStorage.setItem(ADVANCED_KEY, v ? "0" : "1");
      return !v;
    });

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("dashboard-stats", l)))
      .catch(() => setEntitled(false));
  }, [client]);

  const ordered = instances ? sortByOrder(instances, order) : [];
  // 台數多時的名稱搜尋(6 台以上才顯示輸入框);搜尋中仍可拖曳,但只影響顯示順序
  const filtered = listSearch.trim()
    ? ordered.filter((i) => i.name.toLowerCase().includes(listSearch.trim().toLowerCase()))
    : ordered;
  // 拖曳需要移動 8px 才啟動,讓「單純點擊卡片」照樣開啟該伺服器;鍵盤也能排序(無障礙)。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = ordered.map((i) => i.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setOrder(next);
    saveInstanceOrder(next);
  };

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

  // 進階顯示:輪詢每台運作中伺服器的 stats(+REST live)。依賴用排序後的 id 字串,
  // 避免 instances 每 5 秒換新物件導致計時器不停重建。
  const runningKey = (instances ?? [])
    .filter((i) => i.status === "running")
    .map((i) => i.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!advanced || !entitled || !runningKey) {
      setExtras({});
      return;
    }
    const ids = runningKey.split(",");
    let alive = true;
    const poll = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          const [stats, live] = await Promise.all([
            client.stats(id).catch(() => null),
            // REST 未啟用時 live() 會拋錯,不能拖垮整輪。
            client.live(id).catch(() => null),
          ]);
          return [id, { stats, live }] as const;
        }),
      );
      if (alive) setExtras(Object.fromEntries(entries));
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [advanced, client, runningKey]);

  return (
    <>
      <Mascot />
      <AnnouncementPopup />
      {error && <p className={errorCls}>{error}</p>}
      {/* 與實例內頁的標題列(啟動/日誌那排)同一水平線:上方不留 margin;
          下方 mb-6 與 header 的 mb-6 對稱,列表到按鈕列、按鈕列到感謝名單距離相同 */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-[17px] font-extrabold">{t("伺服器")}</h2>
        <div className="flex items-center gap-2">
          {entitled ? (
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5 ${advanced ? "border-pal text-pal" : "opacity-70"}`}
              onClick={toggleAdvanced}
              title={t("在首頁卡片直接顯示在線玩家數與資源用量")}
            >
              <FiActivity className="size-4" /> {t("進階顯示")}
              <FiStar className="size-3.5 text-pal" />
            </button>
          ) : (
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5 opacity-70`}
              title={t("此功能為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
              onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT))}
            >
              <FiActivity className="size-4" /> {t("進階顯示")}
              <FiStar className="size-3.5 text-pal" />
            </button>
          )}
          <button
            className={`${btn} inline-flex items-center gap-1.5`}
            onClick={() => setShowCreate(true)}
            data-testid="create-server"
          >
            <FiPlus className="size-4" /> {t("建立伺服器")}
          </button>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setShowImport(true)}
            data-testid="import-save"
          >
            <FiDownload className="size-4" /> {t("匯入存檔")}
          </button>
        </div>
      </div>
      {advanced && entitled && instances && instances.length > 0 && (
        <DashboardOverview instances={instances} extras={extras} />
      )}
      {/* 配置評估健檢:同屬進階顯示(贊助者)。刻意做成不醒目的一行小字入口,
          有需要才點開彈窗跑檢測(檢測會實寫磁碟+對外連線,不適合常駐輪詢)。 */}
      {advanced && entitled && (
        <div className="-mt-1.5 mb-2 flex justify-end">
          <button
            className="inline-flex items-center gap-1.5 text-xs font-bold text-ink-muted transition hover:text-ink"
            onClick={() => setShowReview(true)}
          >
            <FiActivity className="size-3.5" /> {translate("配置評估健檢")}
          </button>
        </div>
      )}
      {showReview && (
        <Overlay onClose={() => setShowReview(false)}>
          <div className="w-200 max-w-full" onClick={(e) => e.stopPropagation()}>
            <SystemReviewCard client={client} onClose={() => setShowReview(false)} />
          </div>
        </Overlay>
      )}
      {instances === null ? (
        <EmptyState icon={<GiEggClutch className="animate-bounce" />}>{t("載入中…")}</EmptyState>
      ) : instances.length === 0 ? (
        <EmptyState icon={<GiSheep />}>
          {t("還沒有伺服器,建立第一個吧!")}
          <button
            type="button"
            className={`${btn} mx-auto mt-3 flex items-center gap-1.5`}
            onClick={() => setShowCreate(true)}
          >
            <FiPlus className="size-4" /> {t("建立伺服器")}
          </button>
        </EmptyState>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filtered.map((i) => i.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(290px,100%),1fr))] gap-3.5">
              {filtered.map((inst) => (
                <SortableServerCard
                  key={inst.id}
                  inst={inst}
                  onOpen={onOpen}
                  // 進階顯示時每張卡都要有資訊區(未運作的當佔位符),排版才不會高低不齊。
                  extra={advanced && entitled ? (extras[inst.id] ?? null) : undefined}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {showCreate && (
        <CreateDialog
          client={client}
          importWorld={pendingImport ?? undefined}
          onClose={() => {
            setShowCreate(false);
            setPendingImport(null);
          }}
          onCreated={(id) => {
            setShowCreate(false);
            setPendingImport(null);
            void refresh();
            // 建立完成直接進入該伺服器頁:安裝進度/啟動/邀請朋友的下一步都在那裡,
            // 不把新手丟回列表自己猜。
            if (id) onOpen(id);
          }}
        />
      )}
      {showImport && (
        <ImportSaveModal
          client={client}
          onClose={() => setShowImport(false)}
          onPicked={(world) => {
            setPendingImport(world);
            setShowImport(false);
            setShowCreate(true);
          }}
        />
      )}
    </>
  );
}

/** 進階顯示的總覽板塊:所有運作中伺服器的加總(玩家/CPU/記憶體/最低 FPS)。 */
function DashboardOverview({
  instances,
  extras,
}: {
  instances: InstanceSummary[];
  extras: Record<string, CardExtra>;
}) {
  useI18n();
  const running = instances.filter((i) => i.status === "running");
  const lives = running
    .map((i) => extras[i.id]?.live)
    .filter((l): l is NonNullable<typeof l> => !!l?.available);
  const statsList = running
    .map((i) => extras[i.id]?.stats)
    .filter((s): s is NonNullable<typeof s> => s != null);
  const players = lives.reduce((sum, l) => sum + l.players.length, 0);
  const maxPlayers = lives.reduce((sum, l) => sum + (l.metrics?.maxplayernum ?? 0), 0);
  const cpuKnown = statsList.filter((s) => knownCpuSample(s.cpuPercent));
  const cpu = cpuKnown.reduce((sum, s) => sum + (s.cpuPercent as number), 0);
  const mem = statsList.reduce((sum, s) => sum + s.memoryBytes, 0);
  const fpsList = lives.map((l) => l.metrics?.serverfps).filter((n): n is number => n != null);
  const minFps = fpsList.length ? Math.min(...fpsList) : null;
  // 更多進階數字(都來自既有輪詢資料,零額外請求):
  const daysList = lives.map((l) => l.metrics?.days).filter((n): n is number => n != null);
  const uptimeList = lives.map((l) => l.metrics?.uptime).filter((n): n is number => n != null);
  const memLimit = Math.max(0, ...statsList.map((s) => s.memoryLimitBytes));
  const memPressure = memLimit > 0 && statsList.length ? (mem / memLimit) * 100 : null;
  const fmtUp = (sec: number) => {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((sec % 3600) / 60)}m`;
  };

  const tiles: { icon: React.ReactNode; label: string; value: string }[] = [
    { icon: <FiServer className="size-4" />, label: translate("運作中伺服器"), value: `${running.length} / ${instances.length}` },
    { icon: <FiUsers className="size-4" />, label: translate("在線玩家總數"), value: lives.length ? `${players}${maxPlayers ? ` / ${maxPlayers}` : ""}` : "—" },
    { icon: <FiCpu className="size-4" />, label: translate("CPU 合計"), value: cpuKnown.length ? `${cpu.toFixed(0)}%` : "—" },
    { icon: <FiHardDrive className="size-4" />, label: translate("記憶體合計"), value: statsList.length ? fmtBytes(mem) : "—" },
    { icon: <FiZap className="size-4" />, label: translate("最低 FPS"), value: minFps != null ? String(minFps) : "—" },
    { icon: <FiActivity className="size-4" />, label: translate("主機記憶體壓力"), value: memPressure != null ? `${memPressure.toFixed(0)}%` : "—" },
    { icon: <FiClock className="size-4" />, label: translate("最長運行時間"), value: uptimeList.length ? fmtUp(Math.max(...uptimeList)) : "—" },
    { icon: <GiEggClutch className="size-4" />, label: translate("最久世界天數"), value: daysList.length ? translate("第 {n} 天", { n: Math.max(...daysList) }) : "—" },
  ];
  return (
    <div className={`${card} mb-3.5 grid grid-cols-2 gap-3 sm:grid-cols-4`}>
      {tiles.map((tl) => (
        <div key={tl.label} className="flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-ink-muted">
            <span className="text-pal">{tl.icon}</span> {tl.label}
          </span>
          <span className="text-lg font-extrabold">{tl.value}</span>
        </div>
      ))}
    </div>
  );
}

/** 單張可拖曳排序的伺服器卡片(@dnd-kit)。整張卡是拖曳把手,單純點擊仍會開啟。
 * extra:進階顯示(贊助者)開啟且運作中才有 —— undefined=不顯示,null=載入中。 */
function SortableServerCard({
  inst,
  onOpen,
  extra,
}: {
  inst: InstanceSummary;
  onOpen: (id: string) => void;
  extra?: CardExtra | null;
}) {
  useI18n(); // 語言切換時重繪
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: inst.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`${card} touch-none cursor-grab text-left transition-shadow hover:shadow-(--shadow-cute-hover) active:cursor-grabbing ${
        isDragging ? "z-10 opacity-60 shadow-(--shadow-cute-hover)" : ""
      }`}
      onClick={() => onOpen(inst.id)}
    >
      <div className="flex items-center justify-between gap-2">
        <strong className="text-base font-extrabold">{inst.name}</strong>
        <StatusBadge status={inst.status} />
      </div>
      <p className="mt-1 text-[13px] text-ink-muted">
        {inst.enhancements.length > 0 ? translate("強化") : translate("原味")} · UDP {inst.gamePort}
        {inst.gameVersion && ` · ${inst.gameVersion}`}
      </p>
      {extra !== undefined && (
        <div
          className={`mt-2 grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-card-soft px-3 py-2 text-xs font-bold text-ink-muted ${
            inst.status === "running" ? "" : "opacity-50"
          }`}
        >
            <span className="inline-flex items-center gap-1.5" title={translate("在線玩家")}>
              <FiUsers className="size-3.5 shrink-0 text-pal" />
              {extra?.live?.available
                ? `${extra.live.players.length}${extra.live.metrics ? ` / ${extra.live.metrics.maxplayernum}` : ""}`
                : "—"}
            </span>
            <span className="inline-flex items-center gap-1.5" title={translate("伺服器 FPS")}>
              <FiZap className="size-3.5 shrink-0 text-pal" />
              {extra?.live?.metrics ? `${extra.live.metrics.serverfps} FPS` : "—"}
            </span>
            <span className="inline-flex items-center gap-1.5" title="CPU">
              <FiCpu className="size-3.5 shrink-0 text-pal" />
              {extra?.stats && knownCpuSample(extra.stats.cpuPercent) ? `${extra.stats.cpuPercent.toFixed(0)}%` : "—"}
            </span>
            <span className="inline-flex items-center gap-1.5" title={translate("記憶體")}>
              <FiHardDrive className="size-3.5 shrink-0 text-pal" />
              {extra?.stats ? fmtBytes(extra.stats.memoryBytes) : "—"}
            </span>
            <span className="inline-flex items-center gap-1.5" title={translate("運行時間")}>
              <FiClock className="size-3.5 shrink-0 text-pal" />
              {extra?.stats?.uptimeSeconds != null
                ? fmtDuration(extra.stats.uptimeSeconds)
                : extra?.live?.metrics
                  ? fmtDuration(extra.live.metrics.uptime)
                  : "—"}
            </span>
            <span className="inline-flex items-center gap-1.5" title={translate("影格時間")}>
              <FiActivity className="size-3.5 shrink-0 text-pal" />
              {extra?.live?.metrics ? `${extra.live.metrics.serverframetime.toFixed(1)} ms` : "—"}
            </span>
        </div>
      )}
      {inst.updateAvailable && (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-sun/40 bg-sun/15 px-2.5 py-1 text-xs font-bold text-sun">
          <FiDownload className="size-3.5" /> {translate("有新版本可更新")}
        </p>
      )}
      {inst.installError && (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-berry/40 bg-berry/10 px-2.5 py-1 text-xs font-bold text-berry">
          <FiAlertTriangle className="size-3.5" /> {translate("安裝失敗")}
        </p>
      )}
      {inst.status === "installing" && <InstallProgress percent={inst.installProgress} />}
    </button>
  );
}

function CreateDialog({
  client,
  onClose,
  onCreated,
  importWorld,
}: {
  client: AgentClient;
  onClose: () => void;
  onCreated: (id?: string) => void;
  /** 從「匯入存檔」流程帶進來的世界 — 建立成功後自動匯入並設為啟用世界。 */
  importWorld?: ExternalWorldCandidate;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [backend, setBackend] = useState<"native" | "docker" | "k8s">("native");
  const [serverDir, setServerDir] = useState("");
  const [gamePort, setGamePort] = useState(""); // 空 = 自動分配
  const [maxPlayers, setMaxPlayers] = useState(32);
  const [serverPassword, setServerPassword] = useState("");
  const [k8sNamespace, setK8sNamespace] = useState("");
  const [k8sStatefulSet, setK8sStatefulSet] = useState("");
  const [k8sServiceName, setK8sServiceName] = useState("");
  const [dockerImage, setDockerImage] = useState("");
  const [useWine, setUseWine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState<string | null>(null);
  const [availableBackends, setAvailableBackends] = useState<Backend[]>(["native"]);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [showDirPicker, setShowDirPicker] = useState(false);

  // 精靈三步:0 基本資料 → 1 玩法 → 2 模組;新手不需要理解埠/後端,進階都收在摺疊裡
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState<WorldPreset["id"]>("official");
  const [enhanced, setEnhanced] = useState(false);
  // k8s 是把伺服器跑在叢集裡(agent 只是遙控),所以 agent 這台是不是 macOS 無所謂。
  const isMac = platform === "darwin" && backend !== "k8s";
  const k8sIncomplete = backend === "k8s" && (!k8sNamespace.trim() || !k8sStatefulSet.trim());

  // agent 在 macOS 時,主機無法實際執行 Palworld 伺服器(SteamCMD 32-bit 在
  // Rosetta 下不可用、PalServer 存檔即崩潰),不論 native 或 Docker 都一樣。
  useEffect(() => {
    client.info().then((i) => {
      setPlatform(i.platform);
      if (i.availableBackends && i.availableBackends.length > 0) {
        setAvailableBackends(i.availableBackends);
        if (!i.availableBackends.includes(backend)) {
          setBackend("native");
        }
      }
    }).catch(() => {});
  }, [client]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const presetValues = WORLD_PRESETS.find((x) => x.id === preset)?.values ?? {};
      const created = await client.createInstance({
        name,
        backend,
        // 強化 = 啟動安裝完伺服器檔案後,自動裝 UE4SS + PalDefender(agent 端 autoEnhance)
        flavor: enhanced ? "modded" : "vanilla",
        gamePort: gamePort.trim() === "" ? undefined : Number(gamePort),
        runtime: useWine ? "wine" : undefined,
        serverDir: backend === "native" && serverDir.trim() ? serverDir.trim() : undefined,
        dockerImage: backend === "docker" && dockerImage.trim() ? dockerImage.trim() : undefined,
        k8sNamespace: backend === "k8s" ? k8sNamespace.trim() : undefined,
        k8sStatefulSet: backend === "k8s" ? k8sStatefulSet.trim() : undefined,
        k8sServiceName: backend === "k8s" && k8sServiceName.trim() ? k8sServiceName.trim() : undefined,
        settings: { ...presetValues, ServerPlayerMaxNum: maxPlayers, ServerPassword: serverPassword },
      });
      if (importWorld) await client.importSave(created.id, importWorld.path, false);
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const enhanceAvailable = backend === "native" && platform === "win32";
  const STEP_TITLES = [t("基本資料"), t("玩法"), t("模組")];
  const canNext = step === 0 ? name.trim() !== "" && !k8sIncomplete : true;
  const selectedPreset = WORLD_PRESETS.find((x) => x.id === preset);

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[90vh] w-[520px] max-w-full flex-col gap-3 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
          <GiEggClutch className="size-5 text-pal" /> {t(importWorld ? "建立伺服器並匯入存檔" : "建立伺服器")}
        </h2>

        {/* 步驟指示:新手一眼看懂進度,三步都很短 */}
        <div className="flex items-center gap-2">
          {STEP_TITLES.map((title, i) => (
            <div key={title} className="flex items-center gap-2">
              {/* 已走過的步驟可直接點回;往前仍走「下一步」以維持驗證 */}
              <button
                type="button"
                className={`inline-flex items-center gap-2 ${i < step ? "cursor-pointer" : "cursor-default"}`}
                onClick={() => i < step && setStep(i)}
                disabled={i >= step}
              >
                <span
                  className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-extrabold transition ${
                    i === step ? "bg-pal text-white" : i < step ? "bg-pal/20 text-pal hover:bg-pal/35" : "bg-card-soft text-ink-muted"
                  }`}
                >
                  {i + 1}
                </span>
                <span className={`text-xs font-extrabold ${i === step ? "text-ink" : "text-ink-muted"}`}>{title}</span>
              </button>
              {i < STEP_TITLES.length - 1 && <span className="h-0.5 w-6 rounded bg-line" />}
            </div>
          ))}
        </div>

        {step === 0 && (
          <>
            {importWorld && (
              <div className="rounded-xl border-2 border-pal/30 bg-pal/5 px-3 py-2 text-xs">
                <p className="font-bold text-ink-muted">{t("將匯入的世界")}</p>
                <p className="mt-0.5 font-mono text-[13px] font-bold">{importWorld.guid}</p>
                <p className="text-ink-muted">
                  {importWorld.sizeMB} MB · {t("{n} 位玩家", { n: importWorld.players })}
                </p>
                <p className="mt-1 text-ink-muted">{t("建立後會自動匯入並設為啟用世界,玩家用原本的角色進來即可。")}</p>
                {importWorld.coopHost && (
                  <p className="mt-1 inline-flex items-start gap-1.5 font-bold text-amber-600">
                    <FiAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    {t("這是本機共玩存檔:建立後讓主機玩家先加入一次,再到「存檔備份」分頁按「修復主機角色」完成過戶。")}
                  </p>
                )}
              </div>
            )}
            {isMac && (
              <p className="rounded-xl border-2 border-sun/40 bg-sun/10 px-3 py-2 text-xs text-sun">
                {t("這台 agent 執行在 macOS 上,")}<b>{t("無法實際執行 Palworld 伺服器")}</b>
                {t("(SteamCMD/PalServer 在 macOS 不支援)。請把 agent 裝在 Windows 或 Linux 主機上;這裡僅供開發或管理遠端主機。")}
              </p>
            )}
            <label className={labelCls}>
              {t("伺服器名稱")}
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("例:我的帕魯伺服器")}
                maxLength={40}
                required
              />
              <span className="text-xs font-normal opacity-70">{t("朋友在遊戲內伺服器列表看到的名字,之後隨時可改。")}</span>
            </label>
            <label className={labelCls}>
              {t("伺服器密碼(選填)")}
              <input
                className={inputCls}
                value={serverPassword}
                onChange={(e) => setServerPassword(e.target.value)}
              />
              <span className="text-xs font-normal opacity-70">
                {t("朋友加入時要輸入的密碼。留空 = 不設密碼,任何知道位址的人都能加入。")}
              </span>
            </label>
            <label className={labelCls}>
              {t("最大玩家數")}
              <input
                className={inputCls}
                type="number"
                value={maxPlayers}
                onChange={(e) => setMaxPlayers(Number(e.target.value))}
                min={1}
                max={99}
              />
            </label>

            <details className="rounded-xl border-2 border-line px-3 py-2">
              <summary className="cursor-pointer text-[13px] font-extrabold text-ink-muted">
                {t("進階設定(運行方式 / 埠 / 安裝位置)— 新手用預設值就好")}
              </summary>
              <div className="mt-2 flex flex-col gap-3">
                <label className={labelCls}>
                  {t("運行方式")}
                  <Select value={backend} onChange={(e) => setBackend(e.target.value as "native" | "docker" | "k8s")}>
                    <option value="native" disabled={!availableBackends.includes("native")}>{t("原生(直接在這台主機上運行,推薦)")}</option>
                    <option
                      value="docker"
                      disabled={!availableBackends.includes("docker")}
                      title={
                        !availableBackends.includes("docker")
                          ? platform === "win32"
                            ? t("Windows 的 WSL2 UDP 不支援遊戲伺服器,請改用原生或管理遠端 k8s 實例")
                            : t("未偵測到 Docker,請先安裝並啟動 Docker")
                          : undefined
                      }
                    >
                      {t("Docker 容器(beta)")}
                      {!availableBackends.includes("docker")
                        ? platform === "win32"
                          ? t("(Windows 不支援,請用原生或遠端 k8s)")
                          : t("(未偵測到 Docker)")
                        : platform === "darwin"
                          ? t("(非 x86 平台未經驗證)")
                          : ""}
                    </option>
                    {advancedMode && !importWorld && (
                      <option value="k8s" disabled={!availableBackends.includes("k8s")}>
                        {t("Kubernetes(beta)")}{t("(遠端管理,不在本機運行)")}
                      </option>
                    )}
                  </Select>
                </label>
                {!advancedMode && !importWorld && (
                  <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={advancedMode}
                      onChange={(e) => setAdvancedMode(e.target.checked)}
                    />
                    {t("顯示進階選項(Kubernetes)")}
                  </label>
                )}
                {backend === "docker" && (
                  <label className={labelCls}>
                    {t("自訂鏡像(選填)")}
                    <input
                      className={inputCls}
                      value={dockerImage}
                      onChange={(e) => setDockerImage(e.target.value)}
                      placeholder={t("留空=內建映像;或填 ghcr.io/…/palworld:tag")}
                      maxLength={200}
                    />
                    <span className="text-xs text-ink-muted">
                      {t("沿用你已在 Docker 部署的其他帕魯鏡像。鏡像需已存在於本機(先 docker pull)。")}
                    </span>
                  </label>
                )}
                {backend === "docker" && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={useWine}
                      onChange={(e) => setUseWine(e.target.checked)}
                    />
                    {t("Wine 模式(Windows binary,支援 PalDefender)")}
                  </label>
                )}
                {backend === "k8s" && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={useWine}
                      onChange={(e) => setUseWine(e.target.checked)}
                    />
                    {t("Wine 模式(Windows binary,支援 PalDefender)")}
                  </label>
                )}
                {backend === "k8s" && (
                  <>
                    <p className="rounded-xl border-2 border-pal/30 bg-pal/5 px-3 py-2 text-xs text-ink-muted">
                      {t("k8s 模式不會幫你部署伺服器,而是遙控叢集裡「已存在」的 PalServer StatefulSet:啟動/停止會把副本數在 1 / 0 之間切換,存檔備份等透過 kubectl exec 進 Pod 操作。agent 會依序用 PALSERVER_KUBECONFIG、Pod 內 ServiceAccount、或 ~/.kube/config 連上叢集。")}
                    </p>
                    <label className={labelCls}>
                      {t("命名空間(Namespace)")}
                      <input
                        className={`${inputCls} font-mono`}
                        value={k8sNamespace}
                        onChange={(e) => setK8sNamespace(e.target.value)}
                        placeholder="palworld"
                        required
                      />
                    </label>
                    <label className={labelCls}>
                      {t("StatefulSet 名稱")}
                      <input
                        className={`${inputCls} font-mono`}
                        value={k8sStatefulSet}
                        onChange={(e) => setK8sStatefulSet(e.target.value)}
                        placeholder="palworld-server"
                        required
                      />
                    </label>
                    <label className={labelCls}>
                      {t("Service 名稱(選填,用來顯示連線位址)")}
                      <input
                        className={`${inputCls} font-mono`}
                        value={k8sServiceName}
                        onChange={(e) => setK8sServiceName(e.target.value)}
                        placeholder="palworld-server"
                      />
                    </label>
                  </>
                )}
                {backend === "native" && (
                  <label className={labelCls}>
                    {t("伺服器路徑(選填)")}
                    <div className="flex gap-2">
                      <input
                        className={`${inputCls} flex-1`}
                        value={serverDir}
                        onChange={(e) => setServerDir(e.target.value)}
                        placeholder={
                          platform === "win32"
                            ? t("例:{path}", { path: "D:\\palworld\\my-server" })
                            : t("例:{path}", { path: "/opt/palworld/my-server" })
                        }
                      />
                      <button
                        type="button"
                        className={`${btnGhost} inline-flex items-center gap-1.5 px-3`}
                        onClick={() => setShowDirPicker(true)}
                        title={t("瀏覽資料夾")}
                      >
                        <FiFolder className="size-4" />
                      </button>
                    </div>
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
                    min={1024}
                    max={65535}
                    value={gamePort}
                    placeholder={t("自動(從 8211 起找可用埠)")}
                    onChange={(e) => setGamePort(e.target.value)}
                  />
                  <span className="text-xs font-normal opacity-70">
                    {t("朋友連線用的「門牌號碼」,預設 8211 即可。從網際網路直連需在路由器開放此 UDP 埠;用 VPN(如 Tailscale)則不用開,教學見官網。")}
                  </span>
                </label>
              </div>
            </details>
          </>
        )}
        {showDirPicker && (
          <DirectoryPicker
            client={client}
            initialPath={serverDir}
            onSelect={(path) => {
              setServerDir(path);
              setShowDirPicker(false);
            }}
            onClose={() => setShowDirPicker(false)}
          />
        )}

        {/* 精靈:步驟 1 (玩法),步驟 2 (模組) */}
        {step === 1 && (
          <>
            <p className="text-[13px] text-ink-muted">
              {t("選一個起跑點就好 — 建立後所有數值都能在「世界設定」分頁隨時微調。")}
            </p>
            {WORLD_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                className={`rounded-xl border-2 px-3 py-2.5 text-left transition ${
                  preset === p.id ? "border-pal bg-pal/5" : "border-line bg-card-soft/40 hover:border-pal/50"
                }`}
              >
                <p className="text-sm font-extrabold">{t(p.label)}</p>
                <p className="mt-0.5 text-xs text-ink-muted">{t(p.description)}</p>
                {p.highlights.length > 0 && (
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {p.highlights.map((h) => (
                      <span key={h} className="rounded-full bg-card-soft px-1.5 py-0.5 text-[11px] font-bold text-ink-muted">
                        {t(h)}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </>
        )}

        {step === 2 && (
          <>
            <p className="text-[13px] text-ink-muted">
              {t("要不要幫伺服器裝上強化模組?之後也隨時能在「模組」分頁安裝或移除。")}
            </p>
            <button
              type="button"
              onClick={() => setEnhanced(false)}
              className={`rounded-xl border-2 px-3 py-2.5 text-left transition ${
                !enhanced ? "border-pal bg-pal/5" : "border-line bg-card-soft/40 hover:border-pal/50"
              }`}
            >
              <p className="inline-flex items-center gap-1.5 text-sm font-extrabold">
                <FiServer className="size-4 text-pal" /> {t("原生")}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {t("純官方伺服器,最穩定。適合單純想跟朋友一起玩的島主 — 拿不定主意選這個。")}
              </p>
            </button>
            <button
              type="button"
              onClick={() => enhanceAvailable && setEnhanced(true)}
              disabled={!enhanceAvailable}
              className={`rounded-xl border-2 px-3 py-2.5 text-left transition ${
                enhanced ? "border-pal bg-pal/5" : "border-line bg-card-soft/40"
              } ${enhanceAvailable ? "hover:border-pal/50" : "cursor-not-allowed opacity-60"}`}
            >
              <p className="inline-flex items-center gap-1.5 text-sm font-extrabold">
                <FiZap className="size-4 text-pal" /> {t("強化(自動安裝模組)")}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {t("首次啟動時自動裝好 UE4SS 與 PalDefender:反作弊保護、進階玩家管理(給道具/傳送/封禁)、更多管理指令。")}
              </p>
              {!enhanceAvailable && (
                <p className="mt-1 text-xs font-bold text-ink-muted">
                  {backend !== "native"
                    ? t("強化模式目前僅支援「原生」運行方式。")
                    : t("模組(UE4SS/PalDefender)僅支援 Windows 主機。")}
                </p>
              )}
              {enhanced && (
                <p className="mt-1.5 inline-flex items-start gap-1.5 rounded-lg bg-sun/10 px-2 py-1.5 text-xs font-bold text-sun">
                  <FiAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {t("注意:模組是第三方社群專案,遊戲改版初期可能造成閃退或遊戲異常。出問題時到「模組」分頁移除即可恢復原生。")}
                </p>
              )}
            </button>
            {selectedPreset && (
              <p className="text-xs text-ink-muted">
                {t("玩法:{name}", { name: t(selectedPreset.label) })} · {t("模式:{name}", { name: enhanced ? t("強化") : t("原生") })}
              </p>
            )}
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
          </>
        )}

        {error && <p className={errorCls}>{t(error)}</p>}
        <div className="mt-1 flex flex-wrap gap-2">
          {step > 0 && (
            <button type="button" className={btnGhost} onClick={() => setStep(step - 1)} disabled={busy}>
              {t("上一步")}
            </button>
          )}
          {step < 2 ? (
            <button type="button" className={btn} onClick={() => setStep(step + 1)} disabled={!canNext}>
              {t("下一步")}
            </button>
          ) : (
            <button type="button" className={btn} onClick={() => void submit()} disabled={busy || k8sIncomplete || !name.trim()}>
              {busy ? t(importWorld ? "建立並匯入中…" : "建立中…") : t(importWorld ? "建立並匯入" : "建立")}
            </button>
          )}
          <button type="button" className={btnGhost} onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
