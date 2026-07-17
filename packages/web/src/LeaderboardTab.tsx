import { useCallback, useEffect, useRef, useState } from "react";
import { FiAward, FiDollarSign, FiHelpCircle, FiHome, FiLock, FiRefreshCw, FiTrendingUp, FiUserPlus, FiUsers, FiZap } from "react-icons/fi";
import type { AutoScanSetting, SaveScanStats, SaveScanGuildStat, SaveScanPlayerStat } from "@palserver/shared";
import { guildScore, hasFeature, topPalScore } from "@palserver/shared";
import type { AgentClient } from "./api";
import { displayName, palIconUrl, useGameData, type GameData } from "./gameData";
import { t, useI18n } from "./i18n";
import { EmptyState, btnGhost, card, errorCls } from "./ui";

/**
 * 排行榜分頁 — 存檔掃描統計歷史(save-stats-history)驅動。
 * 榜單吃最新一筆掃描;有前一筆時加「與上次掃描相比」週報區。
 * 不依賴 PalDefender;贊助者功能(leaderboard)。
 */
export function LeaderboardTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const gameData = useGameData();
  const [worldGuid, setWorldGuid] = useState<string | null>(null);
  const [history, setHistory] = useState<SaveScanStats[] | null>(null);
  const [autoScan, setAutoScan] = useState<AutoScanSetting | null>(null);
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [canScan, setCanScan] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("leaderboard", l)))
      .catch(() => setEntitled(false));
  }, [client]);

  const load = useCallback(async () => {
    try {
      const res = await client.statsHistory(instanceId);
      setWorldGuid(res.worldGuid);
      setHistory(res.history);
      setAutoScan(res.autoScan ?? null);
      setNote(null);
      try {
        const health = await client.saveHealth(instanceId, res.worldGuid);
        setCanScan(health.supported);
        if (!health.supported) setNote(health.reason ?? t("此主機不支援存檔掃描"));
      } catch {
        setCanScan(false);
      }
    } catch (err) {
      setCanScan(false);
      setNote(t("無法取得存檔快照:{reason}", { reason: err instanceof Error ? err.message : String(err) }));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const scan = async () => {
    if (!worldGuid) return;
    setError(null);
    setScanning(true);
    try {
      await client.startSaveHealth(instanceId, worldGuid);
      await new Promise<void>((resolve) => {
        const timer = setInterval(async () => {
          try {
            const s = await client.saveHealth(instanceId, worldGuid);
            if (s.phase === "idle") {
              clearInterval(timer);
              if (s.error) setError(s.error);
              resolve();
            }
          } catch {
            /* 暫時性網路錯誤:下一輪再試 */
          }
        }, 2000);
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const latest = history && history.length > 0 ? history[history.length - 1] : null;
  const prev = history && history.length > 1 ? history[history.length - 2] : null;
  const locked = entitled === false;

  return (
    <div className="flex flex-col gap-4">
      {/* 無法取得快照(note)且不能掃描時整列收起,虛線提示框與其他分頁一樣貼齊頂部 */}
      {(latest || !note || (canScan && !locked)) && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">
          {latest
            ? t("資料來自存檔掃描(掃描於 {when})。", { when: new Date(latest.scannedAt).toLocaleString() })
            : note
              ? "" // 無法取得快照時只顯示下方的提示框,不重複「尚未掃描」
              : t("尚未掃描過存檔。點「從存檔刷新」建立快照。")}
        </p>
        {canScan && !locked && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-bold text-ink-muted">
              <input
                type="checkbox"
                className="size-3.5 accent-pal"
                checked={autoScan?.enabled ?? false}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setAutoScan((s) => ({ ...(s ?? { intervalMinutes: 60 }), enabled }));
                  void client
                    .setAutoScan(instanceId, enabled)
                    .then(setAutoScan)
                    .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                }}
              />
              {t("每小時自動掃描(伺服器運作中才掃)")}
            </label>
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5`}
              onClick={() => void scan()}
              disabled={scanning}
            >
              <FiRefreshCw className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
              {scanning ? t("掃描存檔中…(依存檔大小可能需要幾分鐘)") : t("從存檔刷新")}
            </button>
          </div>
        )}
      </div>
      )}

      {error && <p className={errorCls}>{error}</p>}
      {note && !scanning && <EmptyState icon={<FiAward />}>{note}</EmptyState>}

      {locked && (
        <div className="inline-flex items-center gap-2 rounded-cute border-2 border-sun/40 bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
          <FiLock className="size-4 shrink-0" />
          {t("這是贊助者專屬功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}
        </div>
      )}

      {!locked && latest && (
        <>
          {history && history.length > 1 ? (
            <ServerDigest history={history} />
          ) : (
            <p className="text-[13px] text-ink-muted">
              {t("再掃描一次就會有「與上次掃描相比」的變化報告(以兩次掃描為比較基準)。")}
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Board
              icon={<FiTrendingUp className="size-4 text-pal" />}
              title={t("等級榜")}
              hint={t("玩家等級(掃描當下);+n 為與上次掃描相比的成長")}
              rows={topBy(latest.players.filter((p) => p.level !== null), (p) => p.level ?? -1).map((p) => ({
                key: p.uid,
                avatar: <PlayerAvatar seed={p.uid} gameData={gameData} />,
                name: p.name,
                value: `Lv.${p.level}`,
                delta: levelDelta(p, prev),
              }))}
            />
            <Board
              icon={<FiDollarSign className="size-4 text-pal" />}
              title={t("財富榜")}
              hint={t("金幣(含離線背包);解析不到金錢的玩家不列入")}
              rows={topBy(latest.players.filter((p) => p.money !== null), (p) => p.money ?? -1).map((p) => ({
                key: p.uid,
                avatar: <PlayerAvatar seed={p.uid} gameData={gameData} />,
                name: p.name,
                value: (p.money ?? 0).toLocaleString(),
              }))}
            />
            <Board
              icon={<FiZap className="size-4 text-pal" />}
              title={t("最強帕魯榜")}
              hint={t("加權評分 = 等級 + IV總和×0.1 + 星級×10 + 詞條數×5;取每位玩家最強一隻")}
              rows={topBy(latest.players.filter((p) => p.topPal), (p) => topPalKey(p)).map((p) => ({
                key: p.uid,
                avatar: <PalFace p={p} gameData={gameData} />,
                name: palLabel(p, gameData),
                value: t("評分 {score}", { score: p.topPal ? Math.round(topPalScore(p.topPal) * 10) / 10 : 0 }),
                detail: (
                  <div className="flex flex-col gap-1">
                    <p className="text-[11px] font-bold text-ink-muted">
                      {t("Lv.{lv} · IV {iv} · 主人 {name}", {
                        lv: p.topPal?.level ?? "—",
                        iv: p.topPal?.ivTotal ?? 0,
                        name: p.name,
                      })}
                    </p>
                    <PassiveChips ids={p.topPal?.passives ?? []} gameData={gameData} />
                  </div>
                ),
              }))}
            />
            <Board
              icon={<FiHome className="size-4 text-pal" />}
              title={t("公會榜")}
              hint={t("綜合實力 = 平均等級 + 活躍成員×5 + 據點×8 + 據點等級×3 + 駐守帕魯×0.5 + 研究×2")}
              rows={topBy(latest.guilds, (g) => guildScore(g)).map((g) => ({
                key: g.id,
                name: g.name,
                value: t("實力 {score}", { score: Math.round(guildScore(g) * 10) / 10 }),
                detail: <GuildStatChips g={g} />,
              }))}
            />
          </div>
        </>
      )}

      {!locked && history && history.length === 0 && (
        <EmptyState icon={<FiAward />}>
          {t("還沒有排行榜資料。掃描一次存檔就會出現(掃描也會更新健檢與玩家/公會快照)。")}
        </EmptyState>
      )}
    </div>
  );
}

/* ── 頭像:與玩家清單同一套「以 id 雜湊固定選一隻帕魯臉」(帕魯世界沒有玩家頭像) ── */

function PlayerAvatar({ seed, gameData, size = 24 }: { seed: string; gameData: GameData | null; size?: number }) {
  const withIcons = gameData?.pals.filter((p) => p.icon) ?? [];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const pal = withIcons.length ? withIcons[hash % withIcons.length] : null;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-line bg-card-soft"
      style={{ width: size, height: size }}
    >
      {pal?.icon ? <img src={palIconUrl(pal.icon)} alt="" className="size-full object-cover" /> : null}
    </span>
  );
}

/** 最強帕魯榜用:該物種的真實圖示;目錄查不到就退回玩家頭像。 */
function PalFace({ p, gameData, size = 24 }: { p: SaveScanPlayerStat; gameData: GameData | null; size?: number }) {
  const species = p.topPal
    ? gameData?.palByIdLower.get(p.topPal.characterId.replace(/^boss_/i, "").toLowerCase())
    : undefined;
  if (!species?.icon) return <PlayerAvatar seed={p.uid} gameData={gameData} size={size} />;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-line bg-card-soft"
      style={{ width: size, height: size }}
    >
      <img src={palIconUrl(species.icon)} alt="" className="size-full object-cover" />
    </span>
  );
}

/* ── 榜單資料整理 ── */

function topBy<T>(list: T[], key: (x: T) => number, n = 10): T[] {
  return [...list].sort((a, b) => key(b) - key(a)).slice(0, n);
}

/** 最強帕魯排序鍵:shared 的加權評分(與 agent 端 computeScanStats 同一套公式)。 */
function topPalKey(p: SaveScanPlayerStat): number {
  return p.topPal ? topPalScore(p.topPal) : -1;
}

/** 公會列明細:成員/等級/活躍/據點/駐守/倉庫/研究/資產小徽章(舊統計缺的欄位就不顯示)。 */
function GuildStatChips({ g }: { g: SaveScanGuildStat }) {
  const chips: string[] = [
    t("{n} 名成員", { n: g.memberCount }),
    ...(g.avgLevel !== null && g.avgLevel !== undefined ? [t("平均 Lv.{n}", { n: g.avgLevel })] : []),
    ...(g.maxLevel !== null && g.maxLevel !== undefined ? [t("最高 Lv.{n}", { n: g.maxLevel })] : []),
    ...(g.activeMembers !== undefined ? [t("7 日活躍 {n}", { n: g.activeMembers })] : []),
    `${t("{n} 個據點", { n: g.baseCount })}${g.baseCampLevel !== null ? `(Lv.${g.baseCampLevel})` : ""}`,
    ...(g.workerPals ? [t("駐守 {n} 隻", { n: g.workerPals })] : []),
    ...(g.storageKinds !== null && g.storageKinds !== undefined ? [t("倉庫 {n} 種", { n: g.storageKinds })] : []),
    ...(g.researchDone !== null && g.researchDone !== undefined ? [t("研究 {n} 項", { n: g.researchDone })] : []),
    ...(g.totalMoney ? [t("資產 {n}", { n: g.totalMoney.toLocaleString() })] : []),
    ...(g.totalPals ? [t("帕魯 {n} 隻", { n: g.totalPals })] : []),
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c} className="rounded-full bg-card-soft px-1.5 py-0.5 text-[11px] font-bold text-ink-muted">
          {c}
        </span>
      ))}
    </div>
  );
}

/** 詞條小標籤列(最強帕魯榜的明細);詞條 id 經目錄在地化,查不到顯示原始 id。 */
function PassiveChips({ ids, gameData }: { ids: string[]; gameData: GameData | null }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const entry = gameData?.passiveById.get(id);
        return (
          <span key={id} className="rounded-full bg-card-soft px-1.5 py-0.5 text-[11px] font-bold text-ink-muted">
            {entry ? displayName(entry) : id}
          </span>
        );
      })}
    </div>
  );
}

function levelDelta(p: SaveScanPlayerStat, prev: SaveScanStats | null): string | undefined {
  const before = prev?.players.find((x) => x.uid === p.uid);
  if (!before || before.level === null || p.level === null) return undefined;
  const d = p.level - before.level;
  return d > 0 ? `+${d}` : undefined;
}


function palLabel(p: SaveScanPlayerStat, gameData: GameData | null): string {
  const tp = p.topPal;
  if (!tp) return "—";
  const species = gameData?.palByIdLower.get(tp.characterId.replace(/^boss_/i, "").toLowerCase());
  const base = species ? displayName(species) : tp.characterId;
  const star = tp.rank !== null && tp.rank > 1 ? ` ★${tp.rank - 1}` : "";
  // 暱稱與物種名相同就不重複顯示(實機看過「紫霞鹿(紫霞鹿)」)
  return tp.nickname && tp.nickname !== base ? `${tp.nickname}(${base})${star}` : `${base}${star}`;
}

/* ── 伺服器大事:與基準掃描(最近 7 天窗口內最舊一筆)相比的變化 + 全服金錢曲線 ── */

const totalMoney = (s: SaveScanStats) => s.players.reduce((sum, p) => sum + (p.money ?? 0), 0);

function ServerDigest({ history }: { history: SaveScanStats[] }) {
  const latest = history[history.length - 1];
  // 基準:最近 7 天窗口內最舊的一筆;窗口內只有 latest 自己就退回前一筆掃描。
  const cutoff = Date.parse(latest.scannedAt) - 7 * 86_400_000;
  const win = history.filter((h) => Date.parse(h.scannedAt) >= cutoff);
  const base = win.length > 1 ? win[0] : history[history.length - 2];

  const baseUids = new Set(base.players.map((p) => p.uid));
  const newPlayers = latest.players.filter((p) => !baseUids.has(p.uid));
  const baseGuilds = new Map(base.guilds.map((g) => [g.id, g]));
  const newGuilds = latest.guilds.filter((g) => !baseGuilds.has(g.id));
  // 既有公會的據點數增加 = 蓋了新據點
  const newBases = latest.guilds
    .map((g) => {
      const before = baseGuilds.get(g.id);
      return before && g.baseCount > before.baseCount ? { name: g.name, added: g.baseCount - before.baseCount } : null;
    })
    .filter((x): x is { name: string; added: number } => x !== null);

  const gains = latest.players
    .map((p) => {
      const before = base.players.find((x) => x.uid === p.uid);
      return before && before.level !== null && p.level !== null
        ? { name: p.name, delta: p.level - before.level }
        : null;
    })
    .filter((x): x is { name: string; delta: number } => x !== null && x.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3);

  const moneyNow = totalMoney(latest);
  const moneyDelta = moneyNow - totalMoney(base);

  const events: { key: string; icon: React.ReactNode; text: string }[] = [];
  if (newPlayers.length > 0) {
    events.push({
      key: "players",
      icon: <FiUserPlus className="size-3" />,
      text: t("新玩家 {n} 位:{names}", { n: newPlayers.length, names: newPlayers.map((p) => p.name).join("、") }),
    });
  }
  if (gains.length > 0) {
    events.push({
      key: "gains",
      icon: <FiTrendingUp className="size-3" />,
      text: t("練級最快:{list}", { list: gains.map((g) => `${g.name}(+${g.delta})`).join("、") }),
    });
  }
  if (newGuilds.length > 0) {
    events.push({
      key: "guilds",
      icon: <FiUsers className="size-3" />,
      text: t("新公會:{names}", { names: newGuilds.map((g) => g.name).join("、") }),
    });
  }
  if (newBases.length > 0) {
    events.push({
      key: "bases",
      icon: <FiHome className="size-3" />,
      text: t("蓋了新據點:{list}", { list: newBases.map((b) => `${b.name}(+${b.added})`).join("、") }),
    });
  }
  if (moneyDelta !== 0) {
    events.push({
      key: "money",
      icon: <FiDollarSign className="size-3" />,
      text: t("全服金錢 {sign}{n}", { sign: moneyDelta > 0 ? "+" : "-", n: Math.abs(moneyDelta).toLocaleString() }),
    });
  }

  return (
    <div className={`${card} flex flex-col gap-3 p-4 sm:p-5`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-sun/15 text-sun">
          <FiAward className="size-4" />
        </span>
        <p className="text-sm font-extrabold">{t("伺服器大事")}</p>
        <span className="rounded-full bg-card-soft px-2 py-0.5 text-[11px] font-bold text-ink-muted">
          {t("自 {when} 起", { when: new Date(base.scannedAt).toLocaleString() })}
        </span>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          {events.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {events.map((e) => (
                <li key={e.key} className="flex items-start gap-2 text-[13px]">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-pal/12 text-pal">
                    {e.icon}
                  </span>
                  <span className="min-w-0 leading-snug">{e.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl bg-card-soft/60 px-3 py-3 text-[13px] text-ink-muted">
              {t("這段期間伺服器沒有明顯變化。")}
            </p>
          )}
        </div>
        {win.length > 1 && <MoneySparkline series={win.map(totalMoney)} latestLabel={moneyNow.toLocaleString()} />}
      </div>
    </div>
  );
}

/** 全服金錢通膨曲線:窗口內每次掃描的全服金錢總和(漸層面積+終點,看趨勢用)。 */
function MoneySparkline({ series, latestLabel }: { series: number[]; latestLabel: string }) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const xy = series.map((v, i) => [
    (i / (series.length - 1)) * 100,
    28 - ((v - min) / span) * 22,
  ]);
  const pts = xy.map(([x, y]) => `${x},${y}`).join(" ");
  const [endX, endY] = xy[xy.length - 1];
  return (
    <div className="w-full shrink-0 rounded-xl bg-card-soft/60 p-3 sm:w-56">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-bold text-ink-muted">{t("全服金錢趨勢")}</p>
        <p className="font-mono text-[11px] font-extrabold tabular-nums text-ink">{latestLabel}</p>
      </div>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="mt-1 h-12 w-full">
        <defs>
          <linearGradient id="lb-money-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-pal)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-pal)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,32 ${pts} 100,32`} fill="url(#lb-money-fill)" stroke="none" />
        <polyline points={pts} fill="none" stroke="var(--color-pal)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <circle cx={endX} cy={endY} r="2.5" fill="var(--color-pal)" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/* ── 榜單卡片 ── */

/** 標題旁的「?」:點開小卡顯示榜單規則/計算方式(手機也能用,點外面關閉)。 */
function HelpTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!ref.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={t("計算方式")}
        aria-expanded={open}
        className={`grid size-5 place-items-center rounded-full transition hover:bg-card-soft hover:text-pal ${open ? "bg-card-soft text-pal" : "text-ink-muted/70"}`}
        onClick={() => setOpen((v) => !v)}
      >
        <FiHelpCircle className="size-3.5" />
      </button>
      {open && (
        <div className="absolute top-6 right-0 z-20 w-64 max-w-[75vw] rounded-xl border-2 border-line bg-card p-3 text-[12px] leading-relaxed font-bold text-ink shadow-(--shadow-cute) sm:right-auto sm:left-0">
          {text}
        </div>
      )}
    </span>
  );
}

function Board({
  icon,
  title,
  hint,
  rows,
}: {
  icon: React.ReactNode;
  title: string;
  /** 榜單規則/計算方式(收在標題旁的「?」小卡裡) */
  hint?: string;
  rows: {
    key: string;
    name: string;
    value: string;
    delta?: string;
    avatar?: React.ReactNode;
    /** 該列下方的補充明細(例:最強帕魯的詞條標籤) */
    detail?: React.ReactNode;
  }[];
}) {
  return (
    <div className={`${card} flex flex-col gap-2`}>
      <p className="inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
        {icon} {title}
        {hint && <HelpTip text={hint} />}
      </p>
      {rows.length === 0 ? (
        <EmptyState compact>{t("沒有資料")}</EmptyState>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {rows.map((r, i) => (
            <li key={r.key} className="flex flex-col gap-1 text-[13px]">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-extrabold ${
                    i === 0 ? "bg-sun/25 text-sun" : i < 3 ? "bg-pal/15 text-pal" : "bg-card-soft text-ink-muted"
                  }`}
                >
                  {i + 1}
                </span>
                {r.avatar}
                <span className="min-w-0 flex-1 truncate font-bold">{r.name}</span>
                {r.delta && <span className="shrink-0 text-xs font-extrabold text-pal">{r.delta}</span>}
                <span className="shrink-0 font-mono text-xs text-ink-muted">{r.value}</span>
              </div>
              {r.detail && <div className="pl-7">{r.detail}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
