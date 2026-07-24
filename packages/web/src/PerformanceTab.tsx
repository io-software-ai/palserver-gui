import { useEffect, useRef, useState } from "react";
import { FiCpu, FiActivity, FiClock, FiLayers, FiZap, FiHardDrive } from "react-icons/fi";
import type { InstanceStats, LiveStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { EmptyState, card } from "./ui";

/** 走勢圖保留的取樣點數(約 5 分鐘,以 5 秒輪詢計)。 */
const HISTORY = 60;

interface Sample {
  cpu: number | null; // 佔總算力 0–100%(後端正規化後);null 代表尚未取得有效取樣
  perCore: (number | null)[] | null; // per-core 使用率(0–100);null = backend 不支援或首筆
  memPct: number | null;
  fps: number | null;
}

/**
 * 效能分析:把原本擠在總覽的資源用量獨立成一頁,加上走勢圖與更多指標。
 * 系統資源(CPU/記憶體/行程/運行時間)來自 agent;伺服器 FPS 與影格時間來自
 * PalDefender/官方 REST API。遊戲天數、據點數等世界統計不在這裡,留在玩家分頁。
 */
export function PerformanceTab({
  client,
  instanceId,
  running,
}: {
  client: AgentClient;
  instanceId: string;
  running: boolean;
}) {
  useI18n();
  const [stats, setStats] = useState<InstanceStats | null>(null);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const liveMiss = useRef(0);

  useEffect(() => {
    if (!running) {
      setStats(null);
      setLive(null);
      setHistory([]);
      return;
    }
    let alive = true;
    const poll = async () => {
      const [s, l] = await Promise.all([
        client.stats(instanceId).catch(() => null),
        // REST 未啟用時 live() 會拋錯,別讓它拖垮輪詢。
        liveMiss.current < 3 ? client.live(instanceId).catch(() => null) : Promise.resolve(null),
      ]);
      if (!alive) return;
      setStats(s);
      if (l) {
        setLive(l);
        liveMiss.current = l.metrics ? 0 : liveMiss.current + 1;
      }
      const fps = l?.metrics?.serverfps ?? null;
      if (s) {
        const cpuPercent = knownCpuSample(s.cpuPercent) ? s.cpuPercent : null;
        setHistory((prev) =>
          [
            ...prev,
            {
              cpu: cpuPercent,
              perCore: s.perCore ?? null,
              memPct: hasFiniteLimit(s.memoryLimitBytes)
                ? clampRatio(s.memoryBytes / s.memoryLimitBytes)
                : null,
              fps,
            },
          ].slice(-HISTORY),
        );
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, instanceId, running]);

  if (!running) {
    return (
      <EmptyState icon={<FiActivity />}>{t("伺服器未在運作中,啟動後即可看到即時效能。")}</EmptyState>
    );
  }

  const metrics = live?.metrics ?? null;
  const cores = stats && Number.isFinite(stats.cpuCores) && stats.cpuCores > 0 ? stats.cpuCores : 1;
  const cpuPercent = stats && knownCpuSample(stats.cpuPercent) ? stats.cpuPercent : null; // 佔總算力 0–100%(後端正規化)
  const perCore = stats?.perCore ?? null;
  const perCoreScope = stats?.perCoreScope ?? null;
  const memoryLimit = stats?.memoryLimitBytes ?? 0;
  const memoryRatio = stats && hasFiniteLimit(memoryLimit) ? clampRatio(stats.memoryBytes / memoryLimit) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* CPU 概要(總用量 + per-thread 框框,每個執行緒各自帶折線圖+Y 軸) */}
      <CpuOverview
        cpuPercent={cpuPercent}
        cores={cores}
        perCore={perCore}
        perCoreScope={perCoreScope}
        history={history}
      />

      {/* 概要數字磚 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          icon={<FiHardDrive className="size-4" />}
          label={t("記憶體")}
          value={stats ? fmtBytes(stats.memoryBytes) : "—"}
          sub={stats && hasFiniteLimit(memoryLimit) ? `／ ${fmtBytes(memoryLimit)}` : undefined}
        />
        <Stat
          icon={<FiZap className="size-4" />}
          label={t("伺服器 FPS")}
          value={metrics ? String(metrics.serverfps) : "—"}
          sub={metrics ? t("影格 {ms} ms", { ms: metrics.serverframetime.toFixed(1) }) : t("需啟用 REST API")}
        />
        <Stat
          icon={<FiClock className="size-4" />}
          label={t("運行時間")}
          value={stats?.uptimeSeconds != null ? fmtDuration(stats.uptimeSeconds) : "—"}
          sub={stats?.processCount != null ? t("{n} 個行程", { n: stats.processCount }) : undefined}
        />
      </div>

      {/* 詳細用量條 */}
      <div className={`${card} flex flex-col gap-4`}>
        <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
          <FiActivity className="size-4 text-pal" /> {t("資源用量")}
        </h3>
        {stats ? (
          <>
            <Meter
              label={t("CPU（佔總算力）")}
              text={cpuPercent == null ? "—" : `${cpuPercent.toFixed(1)}%`}
              ratio={cpuPercent == null ? null : clampRatio(cpuPercent / 100)}
            />
            <Meter
              label={t("記憶體")}
              text={hasFiniteLimit(memoryLimit) ? `${fmtBytes(stats.memoryBytes)} / ${fmtBytes(memoryLimit)}` : fmtBytes(stats.memoryBytes)}
              ratio={memoryRatio}
            />
          </>
        ) : (
          <p className="text-sm text-ink-muted">{t("讀取中…")}</p>
        )}
      </div>

      {/* 走勢圖 */}
      <div className={`${card} flex flex-col gap-4`}>
        <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
          <FiActivity className="size-4 text-pal" /> {t("即時走勢")}
          <span className="text-xs font-normal text-ink-muted">{t("(最近約 5 分鐘)")}</span>
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Trend
            title={t("CPU 佔總算力")}
            unit="%"
            color="#F4A64D"
            values={history.map((h) => h.cpu)}
            max={100}
          />
          <Trend
            title={t("記憶體使用率")}
            unit="%"
            color="#7BB0E8"
            values={history.map((h) => (h.memPct == null ? null : h.memPct * 100))}
            max={100}
          />
          {metrics && (
            <Trend
              title={t("伺服器 FPS")}
              unit=""
              color="#8FCf8F"
              values={history.map((h) => h.fps)}
              max={Math.max(60, ...history.flatMap((h) => (h.fps == null ? [] : [h.fps])))}
            />
          )}
        </div>
        {history.length < 2 && <p className="text-xs text-ink-muted">{t("收集資料中,稍待幾秒走勢就會出現。")}</p>}
      </div>

      {metrics && (
        <div className={`${card} flex flex-col gap-3`}>
          <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
            <FiLayers className="size-4 text-pal" /> {t("伺服器效能")}
          </h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <Row k={t("伺服器 FPS")} v={String(metrics.serverfps)} />
            <Row k={t("影格時間")} v={`${metrics.serverframetime.toFixed(1)} ms`} />
            <Row k={t("伺服器運行")} v={fmtDuration(metrics.uptime)} />
          </dl>
          <p className="text-xs text-ink-muted">
            {t("伺服器 FPS 越接近設定的目標越流暢;明顯偏低代表 CPU 吃緊,可到「引擎微調」分頁調整。")}
          </p>
        </div>
      )}
    </div>
  );
}

/** CPU 概要圖卡:總用量數字 + per-thread 框框(每個邏輯處理器一格,各自帶折線圖+XY 軸)。 */
function CpuOverview({
  cpuPercent,
  cores,
  perCore,
  perCoreScope,
  history,
}: {
  cpuPercent: number | null;
  cores: number;
  perCore: (number | null)[] | null;
  perCoreScope: "system" | "container" | null;
  history: Sample[];
}) {
  const scopeLabel = perCoreScope === "system" ? t("系統全執行緒") : perCoreScope === "container" ? t("伺服器專屬") : null;
  const threadCount = perCore?.length ?? cores;
  const hasPerCore = perCore != null && perCore.length > 0;

  return (
    <div className={`${card} flex flex-col gap-3`}>
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-ink-muted">
            <FiCpu className="size-4" /> CPU
          </span>
          <span className="text-2xl font-extrabold">{cpuPercent == null ? "—" : `${cpuPercent.toFixed(0)}%`}</span>
          <span className="text-xs text-ink-muted">{t("佔總算力")}</span>
        </div>
        <span className="text-xs text-ink-muted">
          {t("{n} 執行緒", { n: threadCount })}
          {scopeLabel ? ` · ${scopeLabel}` : ""}
        </span>
      </div>
      {/* per-thread 框框:每個邏輯處理器一格,各自帶完整折線圖 + Y 軸(0–100%) */}
      {hasPerCore ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {perCore!.map((_, threadIdx) => {
            const threadValues = history.map((h) => h.perCore?.[threadIdx] ?? null);
            const lastVal = perCore![threadIdx];
            return (
              <ThreadChart key={threadIdx} index={threadIdx} values={threadValues} lastVal={lastVal} />
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">{t("per-thread 資料累積中,稍待幾秒即出現。")}</p>
      )}
    </div>
  );
}

/** 單一執行緒的框框:標題 + 當前值 + 折線圖(含 Y 軸 0–100% 標示)。 */
function ThreadChart({ index, values, lastVal }: { index: number; values: Array<number | null>; lastVal: number | null }) {
  const W = 120;
  const H = 50;
  const paddingTop = 4;
  const paddingBottom = 4;
  const plotH = H - paddingTop - paddingBottom;
  // Y 軸:0–100%,固定刻度(0/50/100),讓每個框框比例一致可比較。
  const yTicks = [0, 50, 100];
  const pts = values.map((v, i) => {
    if (v == null || !Number.isFinite(v)) return null;
    const x = values.length > 1 ? (i / (values.length - 1)) * W : 0;
    const y = paddingTop + plotH - Math.max(0, Math.min(v / 100, 1)) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const segments: string[][] = [];
  let seg: string[] = [];
  for (const p of pts) {
    if (p == null) { if (seg.length) segments.push(seg); seg = []; }
    else seg.push(p);
  }
  if (seg.length) segments.push(seg);
  const lastDisplay = lastVal == null ? "—" : `${lastVal.toFixed(0)}%`;

  return (
    <div className="rounded-lg border border-line bg-card-soft p-2">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-bold text-ink-muted">{t("執行緒 {n}", { n: index })}</span>
        <span className="text-sm font-extrabold text-pal">{lastDisplay}</span>
      </div>
      <div className="flex gap-1">
        {/* Y 軸標示 */}
        <div className="flex shrink-0 flex-col justify-between py-0.5 text-[8px] leading-none text-ink-muted">
          {yTicks.map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
        {/* 折線圖本體 */}
        <svg viewBox={`0 0 ${W} ${H}`} className="h-12 flex-1 overflow-visible" preserveAspectRatio="none">
          {/* Y=50% 參考線 */}
          <line x1="0" y1={paddingTop + plotH * 0.5} x2={W} y2={paddingTop + plotH * 0.5} stroke="currentColor" strokeWidth="0.5" className="text-line" opacity="0.4" />
          {segments.map((s, i) => s.length > 1 && (
            <polyline key={i} points={s.join(" ")} fill="none" stroke="#F4A64D" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
          ))}
        </svg>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className={`${card} flex flex-col gap-1`}>
      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-ink-muted">
        {icon}
        {label}
      </span>
      <span className="text-2xl font-extrabold">{value}</span>
      {sub && <span className="text-xs text-ink-muted">{sub}</span>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="font-bold">{v}</dd>
    </div>
  );
}

function Meter({ label, text, ratio }: { label: string; text: string; ratio: number | null }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-ink-muted">{label}</span>
        <span className="font-bold">{text}</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-card-soft">
        <div className="h-full rounded-full bg-pal transition-all" style={{ width: ratio == null ? "0%" : `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/** 極簡 SVG 折線走勢圖 —— 用累積的取樣點畫出趨勢。 */
function Trend({
  title,
  unit,
  color,
  values,
  max,
}: {
  title: string;
  unit: string;
  color: string;
  values: Array<number | null>;
  max: number;
}) {
  const W = 260;
  const H = 64;
  const knownValues = values.filter((v): v is number => v != null && Number.isFinite(v));
  const last = knownValues.length ? knownValues[knownValues.length - 1] : null;
  const safeMax = max > 0 ? max : 1;
  const pts = values.map((v, i) => {
    if (v == null || !Number.isFinite(v)) return null;
    const x = values.length > 1 ? (i / (values.length - 1)) * W : 0;
    const y = H - Math.max(0, Math.min(v / safeMax, 1)) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const segments: string[][] = [];
  let segment: string[] = [];
  for (const point of pts) {
    if (point == null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else {
      segment.push(point);
    }
  }
  if (segment.length) segments.push(segment);
  const area = values.length > 1 && pts.every((point) => point != null) ? `0,${H} ${pts.join(" ")} ${W},${H}` : "";

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-bold text-ink-muted">{title}</span>
        <span className="text-sm font-extrabold" style={{ color }}>
          {last == null ? "—" : last.toFixed(unit === "%" ? 0 : 0)}
          {last == null ? "" : unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" preserveAspectRatio="none">
        {segments.some((points) => points.length > 1) && (
          <>
            {area && <polygon points={area} fill={color} opacity="0.12" />}
            {segments.map((points, index) => (
              <polyline key={index} points={points.join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            ))}
          </>
        )}
      </svg>
    </div>
  );
}

export function fmtBytes(n: number): string {
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`;
}

export function knownCpuSample(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasFiniteLimit(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("{d} 天 {h} 時", { d, h });
  if (h > 0) return t("{h} 時 {m} 分", { h, m });
  if (m > 0) return t("{m} 分", { m });
  return t("{s} 秒", { s });
}
