import { useCallback, useEffect, useRef, useState } from "react";
import { FiArrowLeft, FiPlay, FiSquare, FiRefreshCw, FiTerminal, FiX, FiAlertTriangle } from "react-icons/fi";
import type {
  InstanceDetail as Detail,
  LogSource,
  LogSourceId,
  WorldSettings,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { SettingsEditor } from "./SettingsEditor";
import { ModsTab } from "./ModsTab";
import { PalDefenderTab } from "./PalDefenderTab";
import { PlayersTab } from "./PlayersTab";
import { MapTab } from "./MapTab";
import { ConsoleTab } from "./ConsoleTab";
import { SavesTab } from "./SavesTab";
import { RestartCard } from "./RestartCard";
import { VersionCard } from "./VersionCard";
import { ConnectionCard } from "./ConnectionCard";
import { MigrationCard } from "./MigrationCard";
import { InstanceSettingsTab } from "./InstanceSettingsTab";
import { CopyPath } from "./CopyPath";
import { PerformanceTab } from "./PerformanceTab";
import { EngineTab } from "./EngineTab";
import { maskSteamIdsInText } from "./SteamId";
import { STATUS_LABELS } from "./labels";
import { t, t as translate, useI18n } from "./i18n";
import { Overlay, StatusBadge, btn, btnGhost, card, errorCls } from "./ui";

type Tab =
  | "overview"
  | "performance"
  | "players"
  | "map"
  | "settings"
  | "engine"
  | "mods"
  | "paldefender"
  | "saves"
  | "restart"
  | "instance"
  | "logs";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "總覽" },
  { id: "performance", label: "效能分析" },
  { id: "players", label: "玩家" },
  { id: "map", label: "線上地圖" },
  { id: "settings", label: "世界設定" },
  { id: "engine", label: "引擎微調" },
  { id: "mods", label: "模組" },
  { id: "paldefender", label: "PalDefender" },
  { id: "saves", label: "存檔備份" },
  { id: "restart", label: "自動重啟" },
  { id: "instance", label: "設定" },
  { id: "logs", label: "日誌" },
];

export function InstanceDetailPage({
  client,
  instanceId,
  onBack,
  onDeleted,
}: {
  client: AgentClient;
  instanceId: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  useI18n();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [showConsole, setShowConsole] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [palDefender, setPalDefender] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setDetail(await client.getInstance(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  // Gate PalDefender-only tabs on whether the plugin is installed.
  useEffect(() => {
    client
      .mods(instanceId)
      .then((m) => setPalDefender(m.supported && m.paldefender.installed))
      .catch(() => setPalDefender(false));
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (action: "start" | "stop" | "restart") => {
    try {
      await client.action(instanceId, action);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveSettings = async (patch: Partial<WorldSettings>) => {
    setSaving(true);
    try {
      await client.updateSettings(instanceId, patch);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  if (!detail) {
    return (
      <div>
        <button className={btnGhost} onClick={onBack}>
          <FiArrowLeft className="inline size-4" /> {t("返回")}
        </button>
        {error ? <p className={`mt-4 ${errorCls}`}>{error}</p> : <p className="mt-4 text-ink-muted">{t("載入中…")}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button className={btnGhost} onClick={onBack} aria-label={t("返回")}>
            <FiArrowLeft className="inline size-4" />
          </button>
          <h2 className="text-xl font-extrabold">{detail.name}</h2>
          <StatusBadge status={detail.status} />
        </div>
        <div className="flex gap-2">
          {detail.status !== "running" ? (
            <button
              className={`${btn} inline-flex items-center gap-1.5`}
              onClick={() => act("start")}
              disabled={detail.status === "installing"}
            >
              <FiPlay className="size-4" /> {detail.status === "installing" ? t("安裝中…") : t("啟動")}
            </button>
          ) : (
            <button className={`${btn} inline-flex items-center gap-1.5`} onClick={() => act("stop")}>
              <FiSquare className="size-4" /> {t("停止")}
            </button>
          )}
          <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={() => act("restart")}>
            <FiRefreshCw className="size-4" /> {t("重啟")}
          </button>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setShowConsole(true)}
            title={t("指令台")}
            aria-label={t("指令台")}
          >
            <FiTerminal className="size-4" />
          </button>
        </div>
      </div>

      {showConsole && (
        <Overlay onClose={() => setShowConsole(false)}>
          <div
            className={`${card} flex h-[82vh] w-240 max-w-full flex-col gap-3 overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between">
              <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
                <FiTerminal className="size-5 text-pal" /> {t("指令台")}
              </h2>
              <button className={btnGhost} onClick={() => setShowConsole(false)} aria-label={t("關閉")}>
                <FiX className="size-4" />
              </button>
            </div>
            <ConsoleTab client={client} instanceId={detail.id} />
          </div>
        </Overlay>
      )}

      {error && <p className={errorCls}>{error}</p>}

      {detail.installError && (
        <p className={`${errorCls} inline-flex flex-wrap items-start gap-2`}>
          <FiAlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {t("安裝失敗")}:{" "}
            {detail.installError.code === "disk-full"
              ? t("磁碟空間不足,請清出更多空間後再試(Palworld 伺服器約需數十 GB)。")
              : detail.installError.message}{" "}
            <button
              className="underline underline-offset-2 hover:opacity-80"
              onClick={() => setTab("logs")}
            >
              {t("查看日誌")}
            </button>
          </span>
        </p>
      )}

      <div className="flex flex-wrap gap-x-2 gap-y-1 border-b-2 border-line">
        {TABS.filter((t) => t.id !== "paldefender" || palDefender).map((t) => (
          <button
            key={t.id}
            data-tab={t.id}
            className={
              t.id === tab
                ? "-mb-0.5 border-b-[3px] border-pal px-4 py-2 text-sm font-extrabold whitespace-nowrap text-pal"
                : "px-4 py-2 text-sm font-extrabold whitespace-nowrap text-ink-muted transition hover:text-ink"
            }
            onClick={() => setTab(t.id)}
          >
            {translate(t.label)}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab client={client} detail={detail} onRefresh={refresh} />}
      {tab === "performance" && (
        <PerformanceTab client={client} instanceId={detail.id} running={detail.status === "running"} />
      )}
      {tab === "players" && <PlayersTab client={client} instanceId={detail.id} />}
      {tab === "map" && <MapTab client={client} instanceId={detail.id} />}
      {tab === "settings" && (
        <SettingsEditor
          settings={detail.settings}
          saving={saving}
          onSave={saveSettings}
          client={client}
          instanceId={detail.id}
          canEditRaw={detail.backend === "native"}
          running={detail.status === "running"}
        />
      )}
      {tab === "engine" && (
        <EngineTab client={client} instanceId={detail.id} running={detail.status === "running"} />
      )}
      {tab === "mods" && (
        <ModsTab client={client} instanceId={detail.id} running={detail.status === "running"} />
      )}
      {tab === "paldefender" && (
        <PalDefenderTab client={client} instanceId={detail.id} running={detail.status === "running"} />
      )}
      {tab === "saves" && (
        <SavesTab client={client} instanceId={detail.id} running={detail.status === "running"} />
      )}
      {tab === "restart" && <RestartCard client={client} instanceId={detail.id} />}
      {tab === "instance" && (
        <InstanceSettingsTab client={client} detail={detail} onChanged={refresh} onDeleted={onDeleted} />
      )}
      {tab === "logs" && <LogsTab client={client} instanceId={detail.id} />}
    </div>
  );
}

function OverviewTab({
  client,
  detail,
  onRefresh,
}: {
  client: AgentClient;
  detail: Detail;
  onRefresh: () => void;
}) {
  useI18n();
  const [enhancements, setEnhancements] = useState<string[] | null>(null);

  useEffect(() => {
    client
      .mods(detail.id)
      .then((m) => {
        const on: string[] = [];
        if (m.paldefender.installed) on.push("PalDefender");
        if (m.ue4ss.installed) on.push("UE4SS");
        setEnhancements(on);
      })
      .catch(() => setEnhancements(null));
  }, [client, detail.id]);

  const serverPath = detail.effectiveServerDir ?? detail.serverDir;
  const rows: [string, React.ReactNode][] = [
    [t("狀態"), t(STATUS_LABELS[detail.status])],
    [t("運行方式"), detail.backend === "native" ? t("原生") : t("Docker 容器")],
    [
      t("類型"),
      enhancements && enhancements.length > 0 ? t("強化({list})", { list: enhancements.join(" + ") }) : t("原味"),
    ],
    [t("遊戲埠(UDP)"), String(detail.gamePort)],
    ["REST API", detail.settings.RESTAPIEnabled ? t("啟用({port})", { port: Number(detail.settings.RESTAPIPort) }) : t("停用")],
    ["RCON", detail.settings.RCONEnabled ? t("啟用({port})", { port: Number(detail.settings.RCONPort) }) : t("停用")],
    [detail.backend === "native" ? t("行程 PID") : t("容器 ID"), detail.runtimeId ? detail.runtimeId.slice(0, 12) : "—"],
    // 路徑可能很長:中間省略、可點擊複製完整路徑,別讓它把整張卡片撐爆。
    [t("伺服器目錄"), serverPath ? <CopyPath value={serverPath} className="font-mono text-[13px]" /> : t("agent 管理")],
    [t("建立時間"), new Date(detail.createdAt).toLocaleString()],
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className={card}>
        <h3 className="mb-3 text-sm font-extrabold text-ink-muted">{t("伺服器資訊")}</h3>
        <dl className="flex flex-col gap-2">
          {rows.map(([k, v], i) => (
            <div key={i} className="flex items-center justify-between gap-4 text-sm">
              <dt className="shrink-0 text-ink-muted">{k}</dt>
              <dd className="min-w-0 text-right font-bold">
                {typeof v === "string" ? <span className="break-all">{v}</span> : v}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <MigrationCard />
      <VersionCard
        client={client}
        instanceId={detail.id}
        running={detail.status === "running"}
        onUpdateStarted={onRefresh}
      />
      <ConnectionCard client={client} instanceId={detail.id} />
    </div>
  );
}

function LogsTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [sources, setSources] = useState<LogSource[]>([]);
  const [source, setSource] = useState<LogSourceId>("agent");
  const [lines, setLines] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    client.logSources(instanceId).then(setSources).catch(() => setSources([]));
  }, [client, instanceId]);

  useEffect(() => {
    setLines([]);
    const socket = client.logsSocket(instanceId, source);
    socket.onmessage = (ev) => setLines((prev) => [...prev.slice(-999), String(ev.data)]);
    socket.onclose = (ev) => {
      if (ev.code !== 1000 && ev.code !== 1005) {
        setLines((prev) => [...prev, t("— 日誌串流已中斷({reason})—", { reason: String(ev.reason || ev.code) })]);
      }
    };
    return () => socket.close();
  }, [client, instanceId, source]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div className="flex flex-col gap-3">
      {sources.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {sources.map((s) => (
            <button
              key={s.id}
              className={
                s.id === source
                  ? "rounded-full bg-pal px-4 py-1.5 text-[13px] font-extrabold text-white"
                  : "rounded-full border-2 border-line bg-card-soft px-4 py-1.5 text-[13px] font-extrabold text-ink-muted transition hover:border-pal disabled:opacity-40 disabled:hover:border-line"
              }
              onClick={() => setSource(s.id)}
              disabled={!s.available}
              title={s.available ? undefined : t("此日誌尚未產生")}
            >
              {t(s.label)}
            </button>
          ))}
        </div>
      )}
      <pre className="h-[440px] overflow-auto rounded-(--radius-cute) bg-[#1c1927] p-4 font-mono text-xs whitespace-pre-wrap break-all text-[#cfd6df]">
        {lines.length ? maskSteamIdsInText(lines.join("\n")) : t("(尚無日誌)")}
        <div ref={bottomRef} />
      </pre>
    </div>
  );
}
