import { useCallback, useEffect, useRef, useState } from "react";
import { FiArrowLeft, FiPlay, FiSquare, FiRefreshCw, FiSave, FiTerminal, FiX, FiAlertTriangle } from "react-icons/fi";
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
import { PalStatsTab } from "./PalStatsTab";
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
import { SHOW_SPONSOR_FEATURES } from "./flags";
import { PerformanceTab } from "./PerformanceTab";
import { EngineTab } from "./EngineTab";
import { maskSteamIdsInText } from "./SteamId";
import { STATUS_LABELS } from "./labels";
import { TABS, LOCKED_TABS, useHiddenTabs, useHiddenCards, type Tab } from "./tabPrefs";
import { t, t as translate, useI18n } from "./i18n";
import { Overlay, StatusBadge, btn, btnGhost, card, errorCls } from "./ui";


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
  const [hiddenTabs] = useHiddenTabs();
  // 若目前分頁被使用者在設定裡藏起來,退回總覽,避免停在看不見的分頁。
  useEffect(() => {
    if (!LOCKED_TABS.includes(tab) && hiddenTabs.includes(tab)) setTab("overview");
  }, [hiddenTabs, tab]);
  const [showConsole, setShowConsole] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingWorld, setSavingWorld] = useState(false);
  const [palDefender, setPalDefender] = useState(false);
  // 非 null 時代表正在倒數(數字為剩餘秒數),用來鎖按鈕與顯示提示。
  const [countdown, setCountdown] = useState<number | null>(null);

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
    // 手動停止/重啟時,agent 端會依「伺服器重啟設定」裡的倒數秒數,在遊戲聊天室倒數公告
    // 再執行;公告訊息用 GUI 介面語言的模板({n} 由 agent 代入剩餘秒數)。前端只負責把
    // 模板傳過去,並用讀到的秒數跑一個純顯示用的本地倒數。
    const isDowntime = (action === "stop" || action === "restart") && detail?.status === "running";
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const template = !isDowntime
        ? undefined
        : action === "stop"
          ? t("伺服器將在 {n} 秒後停止")
          : t("伺服器將在 {n} 秒後重新啟動");
      if (isDowntime) {
        const seconds = await client
          .restartPolicy(instanceId)
          .then((p) => p.policy.announceSeconds)
          .catch(() => 0);
        if (seconds > 0) {
          const startedAt = Date.now();
          setCountdown(seconds);
          timer = setInterval(() => {
            const left = seconds - Math.floor((Date.now() - startedAt) / 1000);
            setCountdown(left > 0 ? left : 0);
          }, 500);
        }
      }
      await client.action(instanceId, action, template);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (timer) clearInterval(timer);
      setCountdown(null);
    }
  };

  const saveWorld = async () => {
    setSavingWorld(true);
    setError(null);
    try {
      await client.saveWorld(instanceId);
      setNotice(t("世界已存檔"));
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingWorld(false);
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
              disabled={detail.status === "installing" || countdown !== null}
            >
              <FiPlay className="size-4" /> {detail.status === "installing" ? t("安裝中…") : t("啟動")}
            </button>
          ) : (
            <button
              className={`${btn} inline-flex items-center gap-1.5`}
              onClick={() => act("stop")}
              disabled={countdown !== null}
            >
              <FiSquare className="size-4" /> {t("停止")}
            </button>
          )}
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => act("restart")}
            disabled={countdown !== null}
          >
            <FiRefreshCw className="size-4" /> {t("重啟")}
          </button>
          {detail.status === "running" && (
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5`}
              onClick={saveWorld}
              disabled={savingWorld || countdown !== null}
            >
              <FiSave className="size-4" /> {savingWorld ? t("儲存中…") : t("立即存檔")}
            </button>
          )}
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

      {countdown !== null && (
        <p className="rounded-xl bg-sun/15 px-3 py-2 text-[13px] font-bold text-sun">
          {t("已在遊戲聊天室公告,{n} 秒後執行…", { n: countdown })}
        </p>
      )}

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

      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
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
        {TABS.filter((t) => t.id !== "paldefender" || palDefender)
          .filter((t) => t.id !== "palstats" || SHOW_SPONSOR_FEATURES)
          .filter((t) => LOCKED_TABS.includes(t.id) || !hiddenTabs.includes(t.id))
          .map((t) => (
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
      {tab === "players" && (
        <PlayersTab
          client={client}
          instanceId={detail.id}
          onGoToPalDefender={palDefender ? () => setTab("paldefender") : undefined}
        />
      )}
      {tab === "map" && <MapTab client={client} instanceId={detail.id} />}
      {tab === "settings" && (
        <SettingsEditor
          settings={detail.settings}
          saving={saving}
          onSave={saveSettings}
          client={client}
          instanceId={detail.id}
          canEditRaw={true}
          running={detail.status === "running" && detail.backend === "native"}
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
      {tab === "palstats" && <PalStatsTab client={client} instanceId={detail.id} />}
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
  const [hiddenCards, setHiddenCards] = useHiddenCards();

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
    [t("運行方式"), detail.backend === "native" ? t("原生") : detail.backend === "docker" ? t("Docker 容器") : t("Kubernetes Pod")],
    [
      t("類型"),
      enhancements && enhancements.length > 0 ? t("強化({list})", { list: enhancements.join(" + ") }) : t("原味"),
    ],
    [t("遊戲埠(UDP)"), String(detail.gamePort)],
    ["REST API", detail.settings.RESTAPIEnabled ? t("啟用({port})", { port: Number(detail.settings.RESTAPIPort) }) : t("停用")],
    ["RCON", detail.settings.RCONEnabled ? t("啟用({port})", { port: Number(detail.settings.RCONPort) }) : t("停用")],
    [detail.backend === "native" ? t("行程 PID") : detail.backend === "docker" ? t("容器 ID") : t("Pod 名稱"), detail.runtimeId ? detail.runtimeId.slice(0, 12) : "—"],
    // 路徑可能很長:中間省略、可點擊複製完整路徑,別讓它把整張卡片撐爆。
    [t("伺服器目錄"), serverPath ? <CopyPath value={serverPath} className="font-mono text-[13px]" /> : t("agent 管理")],
    [t("建立時間"), new Date(detail.createdAt).toLocaleString()],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-cute border-2 border-sun/45 bg-sun/10 px-4 py-3">
        <p className="inline-flex items-center gap-2 text-sm font-extrabold text-sun">
          <FiAlertTriangle className="size-4 shrink-0" /> {t("多台伺服器?這些埠都不能重複")}
        </p>
        <p className="mt-1 text-[13px] text-ink-muted">
          {t("同一台主機上跑多個伺服器時,每台的以下埠都必須各自不同,否則會發生埠綁定衝突,導致伺服器起不來或玩家連不上:")}
        </p>
        <p className="mt-1 text-[13px] font-bold">
          {t("遊戲埠(port) · Steam 查詢埠(queryport) · RCON 埠 · REST API 埠 · PalDefender REST 埠(預設 17993)")}
        </p>
      </div>
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
      {!hiddenCards.includes("migration") && (
        <MigrationCard onDismiss={() => setHiddenCards([...hiddenCards, "migration"])} />
      )}
      <VersionCard
        client={client}
        instanceId={detail.id}
        running={detail.status === "running"}
        onUpdateStarted={onRefresh}
      />
      {!hiddenCards.includes("invite") && (
        <ConnectionCard
          client={client}
          instanceId={detail.id}
          onDismiss={() => setHiddenCards([...hiddenCards, "invite"])}
        />
      )}
      </div>
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
