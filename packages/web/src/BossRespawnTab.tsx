import { useCallback, useEffect, useMemo, useState } from "react";
import { FiAlertTriangle, FiClock, FiStar } from "react-icons/fi";
import { GiBossKey, GiCrossedSwords, GiDeathSkull, GiCastle } from "react-icons/gi";
import {
  hasFeature,
  isWorldTreeCoord,
  assignReportedBosses,
  bossRespawnInfo,
  dungeonBossInfo,
  type BossRespawnStatus,
  type BossStateEntry,
  type DungeonBossEntry,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { ModInstallCard } from "./ModInstallCard";
import { palIconUrl } from "./gameData";
import { getLang, t, useI18n } from "./i18n";
import { SponsorLockNotice, EmptyState, card, DismissibleWarning, errorCls } from "./ui";

/** bosses.json / worldtree-bosses.json 的一筆(地圖座標 ±1000,已轉換好)。 */
interface Boss {
  name: { en: string; zh: string; "zh-CN"?: string; zhCN?: string; ja: string };
  x: number;
  y: number;
  lv?: number;
  icon?: string;
}
/** 標記所屬座標系,配對時只跟同一世界的 spawner 比(主世界 / 世界樹地圖範圍都是 ±1000,會撞號)。 */
type FrameBoss = Boss & { world: "main" | "tree" };

function bossName(b: Boss, lang: ReturnType<typeof getLang>): string {
  const n = lang === "zh-CN" ? b.name["zh-CN"] ?? b.name.zhCN : b.name[lang];
  return n || b.name.en;
}

/** 秒數 → H:MM:SS 或 MM:SS。 */
function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** epoch 秒 → 當地 HH:MM。 */
function fmtClock(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * 頭目重生時間(贊助者先行版 boss-respawn):安裝純伺服器端的 PalserverBossReporter
 * UE4SS Lua 模組後,顯示全野外頭目(bosses.json)的死活與重生倒數。模組每 15s 回報一次;
 * 沒有玩家在附近的區域不會載入,那些頭目顯示為「未知」——UI 誠實標註這個限制。
 */
export function BossRespawnTab({
  client,
  instanceId,
  running,
}: {
  client: AgentClient;
  instanceId: string;
  running?: boolean;
}) {
  useI18n();
  const lang = getLang();
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<BossRespawnStatus | null>(null);
  const [bosses, setBosses] = useState<FrameBoss[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [hideUnknown, setHideUnknown] = useState(false);
  const [dungeonOnlyDead, setDungeonOnlyDead] = useState(false);
  const [category, setCategory] = useState<"field" | "dungeon">("field");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.bossRespawns(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  // 授權
  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("boss-respawn", l)))
      .catch(() => setEntitled(false));
  }, [client, instanceId]);

  // 全頭目清單(主世界 + 世界樹);缺檔=舊資料包,對應世界略過。
  useEffect(() => {
    let alive = true;
    void (async () => {
      const load = async (url: string, world: "main" | "tree"): Promise<FrameBoss[]> => {
        try {
          const r = await fetch(url);
          if (!r.ok) return [];
          const arr = (await r.json()) as Boss[];
          return Array.isArray(arr) ? arr.map((b) => ({ ...b, world })) : [];
        } catch {
          return [];
        }
      };
      const [main, tree] = await Promise.all([
        load("/game-data/bosses.json", "main"),
        load("/game-data/worldtree-bosses.json", "tree"),
      ]);
      if (alive) setBosses([...main, ...tree]);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 初次載入 + 每 15s 重抓狀態(模組寫檔週期);每 1s 更新倒數顯示。
  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 15000);
    return () => clearInterval(poll);
  }, [refresh]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(tick);
  }, []);

  const locked = entitled === false;

  // 依所屬世界把回報的 spawner 分兩組(避免主世界/世界樹地圖座標撞號誤配)。
  const reported = status?.state?.bosses ?? [];
  const mainReported = useMemo(() => reported.filter((e) => !isWorldTreeCoord(e.x)), [reported]);
  const treeReported = useMemo(() => reported.filter((e) => isWorldTreeCoord(e.x)), [reported]);

  interface Row {
    boss: FrameBoss;
    matched: BossStateEntry | null;
    info: ReturnType<typeof bossRespawnInfo>;
    sortKey: number;
  }
  const rows = useMemo<Row[]>(() => {
    if (!bosses) return [];
    // 一對一指派(依世界分池),避免鄰近頭目共用同一 spawner 或把未載入頭目誤標成鄰居狀態。
    const mainAssign = assignReportedBosses(
      bosses.filter((b) => b.world !== "tree"),
      mainReported,
    );
    const treeAssign = assignReportedBosses(
      bosses.filter((b) => b.world === "tree"),
      treeReported,
    );
    return bosses.map((boss) => {
      const matched = (boss.world === "tree" ? treeAssign : mainAssign).get(boss) ?? null;
      const info = bossRespawnInfo(matched, now);
      // 排序:重生倒數中(最快先) < 存活 < 已擊殺但無倒數 < 未知
      const sortKey =
        info.status === "dead" && info.secondsLeft !== null
          ? info.secondsLeft
          : info.status === "alive"
            ? 1e12
            : info.status === "dead"
              ? 2e12
              : 3e12;
      return { boss, matched, info, sortKey };
    });
  }, [bosses, mainReported, treeReported, now]);

  const sorted = useMemo(() => [...rows].sort((a, b) => a.sortKey - b.sortKey), [rows]);
  const shown = hideUnknown ? sorted.filter((r) => r.info.status !== "unknown") : sorted;
  const counts = useMemo(() => {
    let alive = 0;
    let dead = 0;
    let unknown = 0;
    for (const r of rows) {
      if (r.info.status === "alive") alive++;
      else if (r.info.status === "dead") dead++;
      else unknown++;
    }
    return { alive, dead, unknown, total: rows.length };
  }, [rows]);

  // 地下城頭目(伺服器端資料,有遊戲內建的精準重生時間)。
  const dungeons = status?.state?.dungeons ?? [];
  interface DRow {
    d: DungeonBossEntry;
    info: ReturnType<typeof dungeonBossInfo>;
    sortKey: number;
  }
  const dungeonRows = useMemo<DRow[]>(() => {
    return dungeons
      .map((d) => {
        const info = dungeonBossInfo(d, now);
        // 重生中(最快先)< 存活
        const sortKey = info.status === "dead" && info.secondsLeft !== null ? info.secondsLeft : 1e12;
        return { d, info, sortKey };
      })
      .sort((a, b) => a.sortKey - b.sortKey);
  }, [dungeons, now]);
  const dungeonDead = dungeonRows.filter((r) => r.info.status === "dead").length;
  const shownDungeons = dungeonOnlyDead ? dungeonRows.filter((r) => r.info.status === "dead") : dungeonRows;

  if (!status) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;

  if (!status.supported) {
    return (
      <div className="flex flex-col gap-4">
        {locked && (
          <SponsorLockNotice>{t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}</SponsorLockNotice>
        )}
        <EmptyState icon={<GiBossKey />}>{status.reason}</EmptyState>
      </div>
    );
  }

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await client.installBossReporter(instanceId);
      setNotice(t("頭目回報模組已安裝,伺服器下次啟動後開始回報(每 15 秒更新)。"));
      setTimeout(() => setNotice(null), 5000);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}

      {locked && (
        <SponsorLockNotice>{t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}</SponsorLockNotice>
      )}

      <div className={locked ? "pointer-events-none opacity-55" : undefined}>
        <ModInstallCard
          title={t("頭目重生時間")}
          titleExtra={
            <span className="inline-flex items-center gap-1 rounded-full bg-pal/10 px-2 py-0.5 text-xs font-bold text-pal">
              <FiStar className="size-3" /> {t("贊助者")}
            </span>
          }
          desc={t("安裝純伺服器端的 UE4SS Lua 模組,每 15 秒回報野外頭目與地下城頭目的死活與重生時間。模組只讀取遊戲狀態、不改遊戲內容,玩家端不需安裝任何東西。")}
          installed={status.modInstalled}
          version={status.version ? `${t("模組")} ${status.version}` : null}
          running={running ?? false}
          busy={installing}
          busyLabel={status.modInstalled ? t("更新中…") : t("安裝中…")}
          onInstall={install}
          installLabel={t("安裝頭目回報模組")}
          updateLabel={t("更新模組")}
          installTitle={t("下載安裝頭目回報 Lua 模組(必要時一併安裝相依的 UE4SS)")}
        >
          {!status.modInstalled && (
            <div className="mt-2">
              <DismissibleWarning id="warn-bossrespawn-risk">
                <span className="inline-flex items-start gap-2">
                  <FiAlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {t(
                      "此模組依賴 UE4SS,僅支援 Windows 伺服器,且需重啟伺服器後才會開始回報;改版後 UE4SS 可能暫時失效。安裝前建議先備份存檔。",
                    )}
                  </span>
                </span>
              </DismissibleWarning>
              {status.reason && <p className="mt-2 text-[13px] text-sun">{status.reason}</p>}
            </div>
          )}
        </ModInstallCard>
      </div>

      {!status.modInstalled ? null : (
        <div className="flex flex-col gap-3">
          {status.stale && (
            <p className="rounded-xl bg-sun/10 px-3 py-2 text-[13px] font-bold text-sun">
              {t("模組已停止回報或伺服器未運行,以下狀態可能已過時。")}
            </p>
          )}
          {status.state === null ? (
            <p className="rounded-xl bg-card-soft px-3 py-2 text-[13px] text-ink-muted">
              {t("尚無回報資料。啟動伺服器後,模組會開始每 15 秒回報頭目狀態。")}
            </p>
          ) : (
            <>
              {/* 分段切換:野外頭目 / 地下城頭目 */}
              <div className="inline-flex self-start rounded-full border-2 border-line bg-card-soft p-0.5 text-[13px] font-bold">
                {(["field", "dungeon"] as const).map((cat) => {
                  const active = category === cat;
                  const deadN = cat === "field" ? counts.dead : dungeonDead;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategory(cat)}
                      className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 transition-colors ${
                        active ? "bg-pal text-white" : "text-ink-muted"
                      }`}
                    >
                      {cat === "field" ? <GiCrossedSwords className="size-4" /> : <GiCastle className="size-4" />}
                      {cat === "field" ? t("野外頭目") : t("地下城頭目")}
                      {deadN > 0 && (
                        <span
                          className={`rounded-full px-1.5 text-[11px] ${active ? "bg-white/25" : "bg-sun/20 text-sun"}`}
                        >
                          {deadN}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {category === "field" ? (
                <>
                  {bosses !== null && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-3 text-[13px] font-bold">
                        <span className="inline-flex items-center gap-1 text-grass">
                          <GiCrossedSwords className="size-4" /> {t("存活")} {counts.alive}
                        </span>
                        <span className="inline-flex items-center gap-1 text-sun">
                          <GiDeathSkull className="size-4" /> {t("已擊殺")} {counts.dead}
                        </span>
                        <span className="inline-flex items-center gap-1 text-ink-muted">
                          {t("未知")} {counts.unknown} / {t("共 {n}", { n: counts.total })}
                        </span>
                      </div>
                      <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-bold text-ink-muted">
                        <input type="checkbox" checked={hideUnknown} onChange={(e) => setHideUnknown(e.target.checked)} />
                        {t("只顯示有狀態的頭目")}
                      </label>
                    </div>
                  )}
                  <p className="text-xs text-ink-muted">
                    {t("沒有玩家在附近時,遠方區域的頭目不會被載入,狀態顯示為「未知(區域未載入)」。重生倒數以官方預設 60 分鐘估算,實測到一輪重生後改用實測值。")}
                  </p>
                  {bosses === null ? (
                    <p className="text-ink-muted">{t("載入頭目清單…")}</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {shown.map((r) => (
                        <BossRow key={`${r.boss.world}:${r.boss.name.en}:${r.boss.x},${r.boss.y}`} row={r} lang={lang} />
                      ))}
                      {shown.length === 0 && (
                        <EmptyState icon={<GiBossKey />}>{t("目前沒有可顯示的頭目狀態。")}</EmptyState>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3 text-[13px] font-bold">
                      <span className="inline-flex items-center gap-1 text-grass">
                        <GiCrossedSwords className="size-4" /> {t("存活")} {dungeonRows.length - dungeonDead}
                      </span>
                      <span className="inline-flex items-center gap-1 text-sun">
                        <GiDeathSkull className="size-4" /> {t("已擊殺")} {dungeonDead}
                      </span>
                      <span className="inline-flex items-center gap-1 text-ink-muted">
                        {t("共 {n}", { n: dungeonRows.length })}
                      </span>
                    </div>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-bold text-ink-muted">
                      <input
                        type="checkbox"
                        checked={dungeonOnlyDead}
                        onChange={(e) => setDungeonOnlyDead(e.target.checked)}
                      />
                      {t("只顯示重生中的地城")}
                    </label>
                  </div>
                  <p className="text-xs text-ink-muted">
                    {t("地城頭目的重生時間由遊戲直接提供(精準),且是伺服器端資料,不需玩家在附近。")}
                  </p>
                  <div className="flex flex-col gap-2">
                    {shownDungeons.map((r) => (
                      <DungeonRow key={`${r.d.name}:${r.d.x},${r.d.y}`} row={r} />
                    ))}
                    {dungeonRows.length === 0 ? (
                      <EmptyState icon={<GiCastle />}>{t("目前沒有地下城頭目資料。")}</EmptyState>
                    ) : (
                      shownDungeons.length === 0 && (
                        <EmptyState icon={<GiCastle />}>{t("目前沒有重生中的地城頭目。")}</EmptyState>
                      )
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DungeonRow({
  row,
}: {
  row: { d: DungeonBossEntry; info: ReturnType<typeof dungeonBossInfo> };
}) {
  const { d, info } = row;
  return (
    <div className={`${card} flex items-center gap-3 !p-3`}>
      <div className="grid size-10 shrink-0 place-items-center rounded-full border-2 border-line bg-card-soft">
        <GiCastle className="size-5 text-ink-muted" />
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-extrabold">{d.name || t("地下城")}</span>
        <span className="text-xs text-ink-muted">{d.level > 0 ? `Lv.${d.level}` : t("地下城")}</span>
      </div>
      <div className="ml-auto text-right">
        {info.status === "alive" ? (
          <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-grass/40 bg-grass/15 px-3 py-1 text-xs font-bold text-grass">
            <GiCrossedSwords className="size-3.5" /> {t("存活")}
          </span>
        ) : (
          <div className="flex flex-col items-end gap-0.5">
            <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-sun/40 bg-sun/10 px-3 py-1 text-xs font-bold text-sun">
              <GiDeathSkull className="size-3.5" /> {t("已擊殺")}
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-ink-muted">
              <FiClock className="size-3" />
              {info.secondsLeft !== null && info.secondsLeft > 0
                ? t("重生倒數 {c}", { c: fmtCountdown(info.secondsLeft) })
                : t("應已重生")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function BossRow({
  row,
  lang,
}: {
  row: {
    boss: FrameBoss;
    matched: BossStateEntry | null;
    info: ReturnType<typeof bossRespawnInfo>;
  };
  lang: ReturnType<typeof getLang>;
}) {
  const { boss, matched, info } = row;
  const iconUrl = boss.icon ? palIconUrl(boss.icon) : null;
  return (
    <div className={`${card} flex items-center gap-3 !p-3`}>
      <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full border-2 border-line bg-card-soft">
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-full object-cover" />
        ) : (
          <GiBossKey className="size-5 text-ink-muted" />
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-extrabold">{bossName(boss, lang)}</span>
        <span className="text-xs text-ink-muted">
          {boss.lv ? `Lv.${boss.lv}` : t("野外頭目")}
          {boss.world === "tree" ? ` · ${t("世界樹")}` : ""}
        </span>
      </div>
      <div className="ml-auto text-right">
        <StatusChip matched={matched} info={info} />
      </div>
    </div>
  );
}

function StatusChip({
  matched,
  info,
}: {
  matched: BossStateEntry | null;
  info: ReturnType<typeof bossRespawnInfo>;
}) {
  if (info.status === "alive") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-grass/40 bg-grass/15 px-3 py-1 text-xs font-bold text-grass">
        <GiCrossedSwords className="size-3.5" /> {t("活著")}
      </span>
    );
  }
  if (info.status === "dead") {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-sun/40 bg-sun/10 px-3 py-1 text-xs font-bold text-sun">
          <GiDeathSkull className="size-3.5" />
          {info.diedAt !== null ? t("已擊殺 {t}", { t: fmtClock(info.diedAt) }) : t("已擊殺(時間未知)")}
        </span>
        {info.secondsLeft !== null && (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-ink-muted">
            <FiClock className="size-3" />
            {info.secondsLeft > 0
              ? t("重生倒數 {c}", { c: fmtCountdown(info.secondsLeft) })
              : t("應已重生")}
            {info.measured ? ` · ${t("實測")}` : ""}
          </span>
        )}
      </div>
    );
  }
  // unknown:區分「已載入但判不出」與「區域未載入」
  return (
    <span className="rounded-full border-[1.5px] border-line bg-card-soft px-3 py-1 text-xs font-bold text-ink-muted">
      {matched ? t("未知(附近無玩家)") : t("未知(區域未載入)")}
    </span>
  );
}
