import { useCallback, useEffect, useRef, useState } from "react";
import { FiArrowLeft, FiPlay, FiSquare, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import type {
  InstanceDetail as Detail,
  InstanceStats,
  LogSource,
  LogSourceId,
  WorldSettings,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { SettingsEditor } from "./SettingsEditor";
import { ModsTab } from "./ModsTab";
import { PlayersTab } from "./PlayersTab";
import { MapTab } from "./MapTab";
import { ConsoleTab } from "./ConsoleTab";
import { STATUS_LABELS } from "./labels";
import { StatusBadge, btn, btnDanger, btnGhost, card, errorCls } from "./ui";

type Tab = "overview" | "players" | "map" | "console" | "settings" | "mods" | "logs";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "總覽" },
  { id: "players", label: "玩家" },
  { id: "map", label: "線上地圖" },
  { id: "console", label: "指令" },
  { id: "settings", label: "世界設定" },
  { id: "mods", label: "模組" },
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
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setDetail(await client.getInstance(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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

  const remove = async () => {
    if (!detail) return;
    if (!confirm(`確定要刪除「${detail.name}」嗎?世界存檔會保留在磁碟上。`)) return;
    try {
      await client.deleteInstance(instanceId);
      onDeleted();
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
          <FiArrowLeft className="inline size-4" /> 返回
        </button>
        {error ? <p className={`mt-4 ${errorCls}`}>{error}</p> : <p className="mt-4 text-ink-muted">載入中…</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button className={btnGhost} onClick={onBack} aria-label="返回">
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
              <FiPlay className="size-4" /> {detail.status === "installing" ? "安裝中…" : "啟動"}
            </button>
          ) : (
            <button className={`${btn} inline-flex items-center gap-1.5`} onClick={() => act("stop")}>
              <FiSquare className="size-4" /> 停止
            </button>
          )}
          <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={() => act("restart")}>
            <FiRefreshCw className="size-4" /> 重啟
          </button>
          <button className={`${btnDanger} inline-flex items-center gap-1.5`} onClick={remove}>
            <FiTrash2 className="size-4" /> 刪除
          </button>
        </div>
      </div>

      {error && <p className={errorCls}>{error}</p>}

      <div className="flex gap-2 border-b-2 border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={
              t.id === tab
                ? "-mb-0.5 border-b-[3px] border-pal px-4 py-2 text-sm font-extrabold text-pal"
                : "px-4 py-2 text-sm font-extrabold text-ink-muted transition hover:text-ink"
            }
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab client={client} detail={detail} />}
      {tab === "players" && <PlayersTab client={client} instanceId={detail.id} />}
      {tab === "map" && <MapTab client={client} instanceId={detail.id} />}
      {tab === "console" && <ConsoleTab client={client} instanceId={detail.id} />}
      {tab === "settings" && (
        <SettingsEditor
          settings={detail.settings}
          saving={saving}
          onSave={saveSettings}
          client={client}
          instanceId={detail.id}
          canEditRaw={detail.backend === "native"}
        />
      )}
      {tab === "mods" && <ModsTab client={client} instanceId={detail.id} />}
      {tab === "logs" && <LogsTab client={client} instanceId={detail.id} />}
    </div>
  );
}

function OverviewTab({ client, detail }: { client: AgentClient; detail: Detail }) {
  const [stats, setStats] = useState<InstanceStats | null>(null);

  useEffect(() => {
    if (detail.status !== "running") {
      setStats(null);
      return;
    }
    let alive = true;
    const poll = () =>
      client
        .stats(detail.id)
        .then((s) => alive && setStats(s))
        .catch(() => alive && setStats(null));
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, detail.id, detail.status]);

  const fmtBytes = (n: number) =>
    n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`;

  const rows: [string, string][] = [
    ["狀態", STATUS_LABELS[detail.status]],
    ["運行方式", detail.backend === "native" ? "原生" : "Docker 容器"],
    ["版本", detail.flavor === "vanilla" ? "原味" : "模組版"],
    ["遊戲埠(UDP)", String(detail.gamePort)],
    ["REST API", detail.settings.RESTAPIEnabled ? `啟用(${detail.settings.RESTAPIPort})` : "停用"],
    ["RCON", detail.settings.RCONEnabled ? `啟用(${detail.settings.RCONPort})` : "停用"],
    [detail.backend === "native" ? "行程 PID" : "容器 ID", detail.runtimeId ? detail.runtimeId.slice(0, 12) : "—"],
    ["伺服器目錄", detail.serverDir ?? "agent 管理"],
    ["建立時間", new Date(detail.createdAt).toLocaleString()],
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className={card}>
        <h3 className="mb-3 text-sm font-extrabold text-ink-muted">伺服器資訊</h3>
        <dl className="flex flex-col gap-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 text-sm">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="font-bold">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className={card}>
        <h3 className="mb-3 text-sm font-extrabold text-ink-muted">資源用量</h3>
        {stats ? (
          <div className="flex flex-col gap-4">
            <Meter label="CPU" text={`${stats.cpuPercent.toFixed(1)}%`} ratio={Math.min(stats.cpuPercent / 100, 1)} />
            <Meter
              label="記憶體"
              text={`${fmtBytes(stats.memoryBytes)} / ${fmtBytes(stats.memoryLimitBytes)}`}
              ratio={stats.memoryLimitBytes ? stats.memoryBytes / stats.memoryLimitBytes : 0}
            />
          </div>
        ) : (
          <p className="text-sm text-ink-muted">伺服器未在運作中。</p>
        )}
      </div>
    </div>
  );
}

function Meter({ label, text, ratio }: { label: string; text: string; ratio: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-ink-muted">{label}</span>
        <span className="font-bold">{text}</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-card-soft">
        <div className="h-full rounded-full bg-pal transition-all" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

function LogsTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
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
        setLines((prev) => [...prev, `— 日誌串流已中斷(${ev.reason || ev.code})—`]);
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
              title={s.available ? undefined : "此日誌尚未產生"}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <pre className="h-[440px] overflow-auto rounded-(--radius-cute) bg-[#1c1927] p-4 font-mono text-xs whitespace-pre-wrap break-all text-[#cfd6df]">
        {lines.length ? lines.join("\n") : "(尚無日誌)"}
        <div ref={bottomRef} />
      </pre>
    </div>
  );
}
