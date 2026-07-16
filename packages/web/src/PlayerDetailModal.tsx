import { useCallback, useEffect, useMemo, useState } from "react";
import { FiX, FiBookOpen, FiCpu, FiHome, FiLock, FiMapPin, FiPackage, FiRefreshCw, FiTrendingUp, FiUser, FiZap, FiShield } from "react-icons/fi";
import { GiShield } from "react-icons/gi";
import {
  hasFeature,
  savToMap,
  type PdPal,
  type PlayerDetail,
  type PdRestStatus,
  type SavePalRow,
  type SavePlayerInventory,
  type SavePlayerProfile,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { useGameData, displayName, findCharacter, itemIconUrl, type GameData } from "./gameData";
import { maskSteamId } from "./SteamId";
import { localizeBaseName, t, useI18n } from "./i18n";
import { DetailsToggle, Overlay, SponsorHint, card, btn, btnGhost, errorCls, inputCls, useDetailsPref } from "./ui";

/**
 * 玩家詳情 — 兩個資料來源「合併成同一個視圖」,不分區:
 *  - PalDefender REST(即時):線上狀態、隊伍/帕魯箱分組、背包、進度
 *  - 存檔快照(save-tools 掃描,手動刷新):離線也查得到,補上個體值/詞條/星級
 *
 * 帕魯用 InstanceId(兩邊同源的主鍵)對聯。共玩轉檔造成的歸屬殘留
 * (帕魯掛在 0000…0001 名下)請用存檔頁的「主機角色修復/帕魯歸屬過戶」
 * 修正資料本身,這裡不做繞路補償。
 */
export function PlayerDetailModal({
  client,
  instanceId,
  identifier,
  displayLabel,
  onClose,
  onGoToPalDefender,
  onShowOnMap,
}: {
  client: AgentClient;
  instanceId: string;
  identifier: string;
  displayLabel: string;
  onClose: () => void;
  /** Jump to the PalDefender tab so the user can enable REST + set a token. */
  onGoToPalDefender?: () => void;
  /** 切到地圖分頁並聚焦(地圖座標)— 公會據點按鈕用。 */
  onShowOnMap?: (x: number, y: number) => void;
}) {
  useI18n();
  const gameData = useGameData();
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [rest, setRest] = useState<PdRestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── 存檔快照側 ──
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [worldGuid, setWorldGuid] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [profile, setProfile] = useState<SavePlayerProfile | null>(null);
  const [snapNote, setSnapNote] = useState<string | null>(null);
  const [canScan, setCanScan] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // 「詳細資訊」開關:個體值/詞條/離線物品/加點等贊助內容;狀態記憶在 localStorage
  const [showDetails, toggleDetails] = useDetailsPref();

  useEffect(() => {
    client
      .playerDetail(instanceId, identifier)
      .then((d) => {
        setDetail(d);
        if (!d.available) client.palDefenderRest(instanceId).then(setRest).catch(() => {});
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        client.palDefenderRest(instanceId).then(setRest).catch(() => {});
      });
  }, [client, instanceId, identifier]);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("save-slim", l)))
      .catch(() => setEntitled(false));
  }, [client, instanceId]);

  const restUid = detail?.available ? detail.playerUid : null;

  /** 讀快照清單,比對出這位玩家後抓完整檔案;失敗原因寫進 snapNote。 */
  const loadSnapshot = useCallback(async () => {
    try {
      const summary = await client.playersSnapshot(instanceId);
      setWorldGuid(summary.worldGuid);
      setGeneratedAt(summary.generatedAt);
      try {
        const health = await client.saveHealth(instanceId, summary.worldGuid);
        setCanScan(health.supported);
        if (!health.supported) setSnapNote(health.reason ?? t("此主機不支援存檔掃描"));
      } catch {
        setCanScan(false);
      }
      if (!summary.generatedAt) {
        setProfile(null);
        return;
      }
      const match =
        (restUid && summary.players.find((p) => normId(p.uid) === normId(restUid))) ||
        summary.players.find((p) => p.name === displayLabel);
      if (!match) {
        setProfile(null);
        setSnapNote(t("快照裡找不到這位玩家(名稱或 UID 對不上)。掃描一次最新存檔試試。"));
        return;
      }
      const { profile: full } = await client.playerSnapshotProfile(instanceId, summary.worldGuid, match.uid);
      setProfile(full);
      setSnapNote(null);
    } catch (err) {
      // 舊版 agent 沒有快照端點、或世界解析失敗 → 把原因講清楚,不留死按鈕
      setCanScan(false);
      setSnapNote(
        t("無法取得存檔快照:{reason}", {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }, [client, instanceId, restUid, displayLabel]);

  useEffect(() => {
    // 快照基礎資料(最後上線/位置分頁/公會據點座標)對所有人開放,深度內容由詳細開關把關
    void loadSnapshot();
  }, [loadSnapshot]);

  const scan = async () => {
    if (!worldGuid) return;
    setScanError(null);
    setScanning(true);
    try {
      await client.startSaveHealth(instanceId, worldGuid);
      await new Promise<void>((resolve) => {
        const timer = setInterval(async () => {
          try {
            const s = await client.saveHealth(instanceId, worldGuid);
            if (s.phase === "idle") {
              clearInterval(timer);
              if (s.error) setScanError(s.error);
              resolve();
            }
          } catch {
            /* 暫時性網路錯誤:下一輪再試 */
          }
        }, 2000);
      });
      await loadSnapshot();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  // 這位玩家名下帕魯的 InstanceId 索引(REST 卡片就地補個體值/詞條用)
  const saveByInstance = useMemo(() => {
    const m = new Map<string, SavePalRow>();
    for (const p of profile?.pals ?? []) if (p.instanceId) m.set(normId(p.instanceId), p);
    return m;
  }, [profile]);

  const restAvailable = !!detail?.available;
  const needsRestSetup = !!rest?.installed && !(rest.enabled && rest.hasToken);

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[85vh] w-[720px] max-w-full flex-col gap-4 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-lg font-extrabold">{displayLabel}</h2>
          <div className="flex items-center gap-2">
            <DetailsToggle
              show={showDetails}
              onToggle={toggleDetails}
              hint={t("個體值、詞條、離線物品、加點分配、進度與科技")}
            />
            {canScan && (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5`}
                onClick={() => void scan()}
                disabled={scanning}
              >
                <FiRefreshCw className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
                {scanning ? t("掃描存檔中…(依存檔大小可能需要幾分鐘)") : t("從存檔刷新")}
              </button>
            )}
            <button className={btnGhost} onClick={onClose}>
              <FiX className="inline size-4" /> {t("關閉")}
            </button>
          </div>
        </div>

        {generatedAt && (
          <p className="-mt-2 text-xs text-ink-muted">
            {t("存檔資料掃描於 {when};即時資料(在線/背包)來自 PalDefender。", {
              when: new Date(generatedAt).toLocaleString(),
            })}
          </p>
        )}

        {error && <p className={errorCls}>{error}</p>}
        {scanError && <p className={errorCls}>{t("存檔掃描失敗:{reason}", { reason: scanError })}</p>}
        {snapNote && !scanning && <p className="text-[13px] text-ink-muted">{snapNote}</p>}
        {canScan && !generatedAt && !scanning && !snapNote && (
          <p className="text-[13px] text-ink-muted">
            {t("尚未掃描過存檔。點「從存檔刷新」建立快照:不依賴 PalDefender,離線玩家也查得到,並包含個體值與詞條。")}
          </p>
        )}

        {!detail && !error && <p className="text-ink-muted">{t("載入中…")}</p>}

        {detail && !restAvailable && !profile && (
          <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-8 text-center text-ink-muted">
            <GiShield className="mx-auto mb-2 size-11" />
            <p className="font-bold">{t("無法讀取玩家細節")}</p>
            <p className="mt-1 text-[13px]">{detail.reason}</p>

            {needsRestSetup ? (
              <div className="mt-4 flex flex-col items-center gap-3">
                <p className="text-[13px]">
                  {t("玩家細節需要 PalDefender 的 REST API。請到 PalDefender 分頁啟用 REST API 並建立存取權杖。")}
                </p>
                <p className="text-xs text-sun">{t("啟用或變更後,需要重啟伺服器一次才會生效。")}</p>
                {onGoToPalDefender && (
                  <button
                    className={`${btn} inline-flex items-center gap-1.5`}
                    onClick={() => {
                      onClose();
                      onGoToPalDefender();
                    }}
                  >
                    <FiShield className="size-4" /> {t("前往 PalDefender 設定")}
                  </button>
                )}
              </div>
            ) : rest && !rest.installed ? (
              <p className="mt-2 text-xs">
                {t("即時玩家細節需要安裝 PalDefender 並啟用其 REST API;或用上方「從存檔刷新」改讀存檔資料。")}
              </p>
            ) : null}
          </div>
        )}

        {(restAvailable || profile) && (
          <MergedBody
            detail={restAvailable ? detail : null}
            profile={profile}
            saveByInstance={saveByInstance}
            gameData={gameData}
            fallbackName={displayLabel}
            details={{ show: showDetails, entitled }}
            onShowOnMap={
              onShowOnMap
                ? (x, y) => {
                    onShowOnMap(x, y);
                    onClose();
                  }
                : undefined
            }
          />
        )}
      </div>
    </Overlay>
  );
}

/** GUID 正規化:兩邊來源的表示法不同(REST 8-8-8-8 大寫、存檔 8-4-4-4-12 小寫),
 *  收斂成純 hex 再比。 */
const normId = (s: string) => s.replace(/[^0-9a-f]/gi, "").toLowerCase();

/** REST + 存檔的單一合併視圖。任一來源缺席時,另一邊獨立成立。 */
function MergedBody({
  detail,
  profile,
  saveByInstance,
  gameData,
  fallbackName,
  details,
  onShowOnMap,
}: {
  detail: PlayerDetail | null;
  profile: SavePlayerProfile | null;
  saveByInstance: Map<string, SavePalRow>;
  gameData: GameData | null;
  fallbackName: string;
  /** 「詳細資訊」開關(按鈕在彈窗右上角):贊助內容收在裡面 */
  details: { show: boolean; entitled: boolean | null };
  onShowOnMap?: (x: number, y: number) => void;
}) {
  const deep = details.show && details.entitled === true;
  const prog = detail?.available ? detail.progression : null;
  const restPals = detail?.available ? detail.pals : [];

  // 統一格式:REST 與存檔合併成一份 MergedPal 全集,位置以即時資料優先
  // (REST 在線分類),離線退回存檔解析的容器分類;僅存檔的帕魯也併入全集。
  const matched = new Set<string>();
  const all: MergedPal[] = restPals.map((p) => {
    const s = saveByInstance.get(normId(p.instanceId)) ?? null;
    if (s) matched.add(normId(s.instanceId));
    return mergePal(p, s);
  });
  for (const s of profile?.pals ?? []) {
    if (s.instanceId && matched.has(normId(s.instanceId))) continue;
    all.push(mergePal(null, s));
  }

  // REST 有帕魯、快照也有,卻一隻都對不上 → 快照多半是舊版掃的(還沒有 InstanceId)
  const staleSnapshot = restPals.length > 0 && saveByInstance.size > 0 && matched.size === 0;

  const lastOnline =
    profile?.lastOnlineDaysAgo === null || profile?.lastOnlineDaysAgo === undefined
      ? null
      : profile.lastOnlineDaysAgo === 0
        ? t("今天")
        : t("{n} 天前", { n: profile.lastOnlineDaysAgo });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-cute bg-card-soft/60 p-3 text-sm sm:grid-cols-3">
        <Info label={t("名稱")} value={(detail?.available && detail.name) || profile?.name || fallbackName} />
        <Info label={t("公會")} value={(detail?.available && detail.guildName) || profile?.guildName || t("無")} />
        {detail?.available && <Info label="UserId" value={detail.userId ? maskSteamId(detail.userId) : "—"} />}
        <Info
          label={t("等級")}
          value={prog ? `Lv.${prog.level}` : profile?.level !== null && profile ? `Lv.${profile.level}` : "—"}
        />
        {lastOnline !== null && <Info label={t("最後上線")} value={lastOnline} />}
        {deep && profile?.inventory && <Info label={t("金錢")} value={profile.inventory.money.toLocaleString()} />}
      </div>

      {/* 公會據點(座標/跳地圖)對所有人開放,與地圖據點圖層一致 */}
      {profile?.guild && <GuildPanel guild={profile.guild} onShowOnMap={onShowOnMap} />}

      {details.show && details.entitled === false && <SponsorHint />}
      {deep && profile?.statusPoints && profile.statusPoints.length > 0 && (
        <StatusPointsPanel points={profile.statusPoints} unused={profile.unusedStatusPoints ?? null} />
      )}

      {/* 進度(經驗值/科技點/擊敗頭目…)與已解鎖科技:贊助內容,收在詳細開關內 */}
      {deep && prog && <Progression prog={prog} />}
      {/* 圖鑑收集完成度:玩家存檔 RecordData 的登錄/捕捉紀錄 vs 內建物種目錄 */}
      {deep && profile?.paldeck && <PaldeckPanel paldeck={profile.paldeck} gameData={gameData} />}
      {deep && detail?.available && detail.techs && (
        <div>
          <h3 className="mb-1 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
            <FiCpu className="size-4 text-pal" /> {t("已解鎖科技")}
          </h3>
          <p className="text-[13px]">
            {t("{n} / {total} 項", { n: detail.techs.unlockedCount, total: detail.techs.totalCount })}
          </p>
        </div>
      )}

      {deep && staleSnapshot && (
        <p className="rounded-xl bg-sun/10 px-3 py-2 text-[13px] font-bold text-sun">
          {t("存檔快照與即時資料對不上(快照可能是舊版本掃的)。點「從存檔刷新」重掃一次,即可顯示個體值與詞條。")}
        </p>
      )}

      <PalSection pals={all} totalHint={profile?.palCount} gameData={gameData} deep={deep} />

      {all.length === 0 && detail?.available && detail.palsUnavailable && (
        <p className="rounded-xl bg-sun/10 px-3 py-2 text-[13px] font-bold text-sun">
          {t("PalDefender 讀不到離線玩家的帕魯;可用「從存檔刷新」改讀存檔資料。")}
        </p>
      )}

      <ItemSection
        inventory={deep ? (profile?.inventory ?? null) : null}
        restItems={detail?.available ? detail.items : null}
        restUnavailable={detail?.available ? !!detail.itemsUnavailable : false}
        gameData={gameData}
      />
    </div>
  );
}

/** 合併後的帕魯卡資料:REST 給即時面(暱稱/等級/位置),存檔補深度面(IV/詞條/星級)。 */
interface MergedPal {
  key: string;
  speciesId: string;
  nickname?: string;
  level: number | null;
  shiny: boolean;
  isBoss: boolean;
  gender: "male" | "female" | null;
  rank: number;
  /** 位置:即時資料優先(在線分類),否則用存檔解析的容器分類 */
  location: SavePalRow["location"];
  save: SavePalRow | null;
}

const REST_LOCATION: Record<PdPal["location"], SavePalRow["location"]> = {
  team: "party",
  palbox: "palbox",
  basecamp: "base",
};

function mergePal(restPal: PdPal | null, save: SavePalRow | undefined | null): MergedPal {
  const s = save ?? null;
  const speciesId = restPal?.palId ?? s?.characterId ?? "?";
  return {
    key: restPal?.instanceId ?? s?.instanceId ?? speciesId,
    speciesId: speciesId.replace(/^BOSS_/i, ""),
    nickname: restPal?.nickname || s?.nickname || undefined,
    level: restPal?.level ?? s?.level ?? null,
    shiny: restPal?.shiny || s?.isLucky || false,
    isBoss: s?.isBoss || /^BOSS_/i.test(speciesId),
    gender: s?.gender ?? (/female/i.test(restPal?.gender ?? "") ? "female" : /male/i.test(restPal?.gender ?? "") ? "male" : null),
    rank: s?.rank ?? 0,
    location: restPal ? REST_LOCATION[restPal.location] : (s?.location ?? "unknown"),
    save: s,
  };
}

/** 公會面板:職位/成員數/據點等級 + 據點清單(點座標跳地圖,重用地圖的 flyTo)。 */
function GuildPanel({
  guild,
  onShowOnMap,
}: {
  guild: NonNullable<SavePlayerProfile["guild"]>;
  onShowOnMap?: (x: number, y: number) => void;
}) {
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-extrabold text-ink-muted">
        <FiHome className="size-4 text-pal" /> {t("公會")}
        <span className="truncate font-bold text-ink">{guild.name}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-bold ${
            guild.role === "admin" ? "bg-sun/15 text-sun" : "bg-card-soft text-ink-muted"
          }`}
        >
          {guild.role === "admin" ? t("會長") : t("成員")}
        </span>
      </h3>
      <div className="rounded-cute bg-card-soft/60 p-3">
        <p className="text-[13px] text-ink-muted">
          {t("{n} 名成員", { n: guild.memberCount })}
          {guild.baseCampLevel !== null && <> · {t("據點等級 Lv.{n}", { n: guild.baseCampLevel })}</>}
          {" · "}
          {t("{n} 個據點", { n: guild.bases.length })}
        </p>
        {guild.bases.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {guild.bases.map((b, i) => {
              const m = savToMap(b.x, b.y);
              return (
                <button
                  key={b.id}
                  className={`inline-flex items-center gap-1 rounded-full border-2 px-2.5 py-1 text-xs font-bold transition ${
                    onShowOnMap
                      ? "border-line text-ink-muted hover:border-pal hover:text-pal"
                      : "cursor-default border-line text-ink-muted"
                  }`}
                  onClick={onShowOnMap ? () => onShowOnMap(m.x, m.y) : undefined}
                  title={onShowOnMap ? t("在地圖上查看") : undefined}
                >
                  <FiMapPin className="size-3" />
                  {localizeBaseName(b.name, i)}
                  <span className="font-mono font-normal opacity-70">
                    ({Math.round(m.x)}, {Math.round(m.y)})
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 存檔內部加點名稱(日文)→ 顯示標籤。 */
const STATUS_LABELS: Record<string, () => string> = {
  最大HP: () => t("生命"),
  最大SP: () => t("耐力"),
  攻撃力: () => t("攻擊"),
  所持重量: () => t("負重"),
  捕獲率: () => t("捕獲率"),
  作業速度: () => t("工作速度"),
  空腹率低減: () => t("飽食度消耗降低"),
  泳ぎ速度: () => t("游泳速度"),
  食料腐敗低減: () => t("食物腐敗速度降低"),
  ジャンプ力: () => t("跳躍力"),
  滑空速度: () => t("滑翔速度"),
  崖登り速度: () => t("攀爬速度"),
  状態異常耐性: () => t("異常狀態抗性"),
  経験値ボーナス: () => t("經驗值加成"),
  虹パッシブ率: () => t("彩虹被動技能機率"),
  移動速度アップ: () => t("移動速度提升"),
  スタミナ消費軽減: () => t("耐力消耗降低"),
};

/** 加點分配面板(基礎與擴充能力 + 未分配)。 */
function StatusPointsPanel({ points, unused }: { points: { name: string; points: number }[]; unused: number | null }) {
  return (
    <div>
      <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
        <FiTrendingUp className="size-4 text-pal" /> {t("加點分配")}
        {unused !== null && unused > 0 && (
          <span className="rounded-full bg-sun/15 px-2 py-0.5 text-xs font-bold text-sun">
            {t("未分配 {n}", { n: unused })}
          </span>
        )}
      </h3>
      <div className="grid grid-cols-3 gap-2 rounded-cute bg-card-soft/60 p-3 text-sm sm:grid-cols-6">
        {points.map((p) => (
          <div key={p.name}>
            <p className="text-xs text-ink-muted">{STATUS_LABELS[p.name]?.() ?? p.name}</p>
            <p className="font-mono font-extrabold">+{p.points}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 圖鑑收集完成度:paldeck 是存檔登錄/捕捉過的物種 key(大小寫可能與目錄不一致,
 *  用 palByIdLower 不分大小寫對回目錄);分母是內建物種目錄總數。 */
function PaldeckPanel({ paldeck, gameData }: { paldeck: string[]; gameData: GameData | null }) {
  if (!gameData || gameData.pals.length === 0) return null;
  const total = gameData.pals.length;
  const owned = new Set<string>();
  for (const key of paldeck) {
    const hit = gameData.palByIdLower.get(key.toLowerCase());
    if (hit) owned.add(hit.id);
  }
  const pct = Math.min(100, Math.round((owned.size / total) * 100));
  return (
    <div>
      <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
        <FiBookOpen className="size-4 text-pal" /> {t("圖鑑收集")}
      </h3>
      <div className="rounded-cute bg-card-soft/60 p-3">
        <div className="flex items-baseline justify-between text-sm">
          <p className="font-extrabold">{t("{n} / {total} 種", { n: owned.size, total })}</p>
          <p className="text-xs font-bold text-ink-muted">{pct}%</p>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-card">
          <div className="h-full rounded-full bg-pal transition-all" style={{ width: `${Math.max(pct, 1)}%` }} />
        </div>
      </div>
    </div>
  );
}

/** 進度概要:等級/經驗、科技點、頭目、捕捉(PalDefender /progression)。 */
function Progression({ prog }: { prog: NonNullable<PlayerDetail["progression"]> }) {
  const rows: [string, string][] = [
    [t("經驗值"), prog.exp.toLocaleString()],
    [t("未分配狀態點"), String(prog.unusedStatusPoints)],
    [t("科技點數"), String(prog.technologyPoints)],
    [t("古代科技點數"), String(prog.ancientTechnologyPoints)],
    [t("擊敗頭目"), String(prog.bossesDefeated)],
    [t("捕捉帕魯種類"), String(prog.palsCaptured)],
  ];
  return (
    <div>
      <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
        <FiTrendingUp className="size-4 text-pal" /> {t("進度")}
      </h3>
      <div className="grid grid-cols-2 gap-2 rounded-cute bg-card-soft/60 p-3 text-sm sm:grid-cols-3">
        {rows.map(([k, v]) => (
          <Info key={k} label={k} value={v} />
        ))}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="font-bold break-all">{value}</p>
    </div>
  );
}

const SHOWN_PALS = 60;

type PalTab = "all" | "party" | "palbox" | "base";

/**
 * 帕魯區:分頁籤(全部/身上/帕魯箱/據點)+ 即時搜尋 + 統一卡片格。
 * 幾百隻的帕魯箱用堆疊區塊會把彈窗拉成無底洞;籤上帶數量、即點即切,
 * 搜尋涵蓋暱稱/物種顯示名/詞條名。位置未知的(舊快照)只出現在「全部」。
 */
function PalSection({
  pals,
  totalHint,
  gameData,
  deep,
}: {
  pals: MergedPal[];
  /** 存檔明細有上限(每人 1000),真實總數可能更大 */
  totalHint?: number;
  gameData: GameData | null;
  /** 詳細資訊開啟且已解鎖:卡片顯示 IV/詞條深度列 */
  deep: boolean;
}) {
  const [picked, setPicked] = useState<PalTab | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  if (pals.length === 0) return null;

  const counts: Record<PalTab, number> = {
    all: pals.length,
    party: pals.filter((p) => p.location === "party").length,
    palbox: pals.filter((p) => p.location === "palbox").length,
    base: pals.filter((p) => p.location === "base").length,
  };
  // 預設不選「全部」(幾百隻太多):優先身上,其次帕魯箱;都空才退回全部
  const tab: PalTab = picked ?? (counts.party > 0 ? "party" : counts.palbox > 0 ? "palbox" : "all");
  const TABS: { id: PalTab; label: string }[] = [
    { id: "all", label: t("全部") },
    { id: "party", label: t("身上") },
    { id: "palbox", label: t("帕魯箱") },
    { id: "base", label: t("據點") },
  ];

  const q = query.trim().toLowerCase();
  const matchQuery = (p: MergedPal): boolean => {
    if (!q) return true;
    const entity = findCharacter(gameData, p.speciesId)?.entity;
    const hay = [p.nickname, p.speciesId, entity ? displayName(entity) : "", entity?.name]
      .concat(p.save?.passives.map((id) => {
        const meta = gameData?.passiveById.get(id);
        return meta ? `${displayName(meta)} ${meta.name}` : id;
      }) ?? [])
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  };

  const filtered = pals.filter((p) => (tab === "all" || p.location === tab) && matchQuery(p));
  const shown = showAll || q ? filtered : filtered.slice(0, SHOWN_PALS);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
          <FiZap className="size-4 text-pal" /> {t("帕魯")}
          {totalHint !== undefined && totalHint > pals.length && (
            <span className="text-xs font-normal">
              {t("(顯示前 {shown} / 共 {total})", { shown: pals.length, total: totalHint })}
            </span>
          )}
        </h3>
        <input
          className={`${inputCls} w-44 py-1 text-xs`}
          placeholder={t("搜尋名稱、物種或詞條…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => {
              setPicked(id);
              setShowAll(false);
            }}
            className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition ${
              tab === id
                ? "border-pal bg-pal/10 text-pal"
                : "border-line text-ink-muted hover:border-ink-muted"
            }`}
          >
            {label}
            <span className={`ml-1 ${tab === id ? "" : "opacity-70"}`}>{counts[id]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-ink-muted">
          {q ? t("沒有符合搜尋的帕魯。") : t("這個分類沒有帕魯。")}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
          {shown.map((p) => (
            <PalCard key={p.key} p={p} gameData={gameData} deep={deep} />
          ))}
        </div>
      )}
      {!q && !showAll && filtered.length > SHOWN_PALS && (
        <button className={`${btnGhost} mt-2`} onClick={() => setShowAll(true)}>
          {t("顯示全部 {n} 隻", { n: filtered.length })}
        </button>
      )}
    </div>
  );
}

const IV_META = () =>
  [
    { key: "talentHp" as const, label: t("血") },
    { key: "talentShot" as const, label: t("攻") },
    { key: "talentDefense" as const, label: t("防") },
  ] as const;

function PalCard({ p, gameData, deep }: { p: MergedPal; gameData: GameData | null; deep: boolean }) {
  const hit = findCharacter(gameData, p.speciesId);
  const s = deep ? p.save : null;
  return (
    <div className="rounded-xl border-2 border-line p-2.5 transition-colors hover:border-pal/50">
      <div className="flex items-center gap-2.5">
        <span
          className={`flex size-11 shrink-0 items-center justify-center rounded-lg bg-card-soft ${
            p.shiny ? "ring-2 ring-amber-400/70" : ""
          }`}
        >
          {hit?.iconUrl ? (
            <img src={hit.iconUrl} alt="" className="size-10" />
          ) : (
            // 沒有專屬圖示的人類 NPC(或目錄外 id):人形佔位
            <FiUser className="size-6 text-ink-muted" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-extrabold">
            {p.nickname || (hit ? displayName(hit.entity) : p.speciesId)}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
            <span className="font-mono font-bold">{p.level !== null ? `Lv.${p.level}` : "—"}</span>
            {p.gender === "female" && <span className="font-bold text-berry">♀</span>}
            {p.gender === "male" && <span className="font-bold text-pal">♂</span>}
            {p.rank > 1 && <span className="font-bold text-sun">{"★".repeat(Math.min(p.rank - 1, 4))}</span>}
            {p.shiny && (
              <span className="rounded-full bg-amber-400/15 px-1.5 font-bold text-amber-500">✦ {t("幸運")}</span>
            )}
            {p.isBoss && (
              <span className="rounded-full bg-berry/15 px-1.5 font-bold text-berry">{t("頭目")}</span>
            )}
          </p>
        </div>
      </div>

      {s && s.talentHp !== null && (
        <div className="mt-2 grid grid-cols-3 gap-1.5" title={t("個體值:血量 / 攻擊 / 防禦(0-100)")}>
          {IV_META().map(({ key, label }) => {
            const v = s[key] ?? 0;
            return (
              <div key={key} className="rounded-md bg-card-soft px-1.5 py-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] font-bold text-ink-muted">{label}</span>
                  <span className={`text-[11px] font-extrabold ${v >= 90 ? "text-grass" : ""}`}>{v}</span>
                </div>
                <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-line/70">
                  <div
                    className={`h-full rounded-full ${v >= 90 ? "bg-grass" : "bg-pal/70"}`}
                    style={{ width: `${Math.max(v, 2)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {s && s.passives.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s.passives.map((id) => {
            const meta = gameData?.passiveById.get(id);
            const rank = meta?.rank ?? 0;
            return (
              <span
                key={id}
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  rank < 0 ? "bg-berry/10 text-berry" : rank >= 3 ? "bg-amber-400/15 text-amber-600" : "bg-grass/10 text-grass"
                }`}
                title={rank !== 0 ? `${rank > 0 ? "+" : ""}${rank}` : undefined}
              >
                {meta ? displayName(meta) : id}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

type ItemTab = "common" | "weapons" | "armor" | "essential" | "food";

/**
 * 物品區:離線快照有分類資料時走分頁籤(背包/武器/防具/重要/食物,預設背包,
 * 不做「全部」— 太多);沒有快照時退回 PalDefender 的即時扁平清單。
 */
function ItemSection({
  inventory,
  restItems,
  restUnavailable,
  gameData,
}: {
  inventory: SavePlayerInventory | null;
  restItems: PlayerDetail["items"] | null;
  restUnavailable: boolean;
  gameData: GameData | null;
}) {
  const [tab, setTab] = useState<ItemTab>("common");

  // 沒有快照分類資料 → 即時扁平清單(或不可用提示)
  if (!inventory) {
    if (!restItems) return null;
    if (restItems.length === 0) {
      return (
        <p className="text-[13px] text-ink-muted">
          {restUnavailable
            ? t("PalDefender 讀不到離線玩家的背包;可用「從存檔刷新」改讀存檔資料。")
            : t("沒有讀取到背包資料。")}
        </p>
      );
    }
    const merged = new Map<string, number>();
    for (const s of restItems) merged.set(s.itemId, (merged.get(s.itemId) ?? 0) + s.count);
    const rows = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([itemId, count]) => ({ itemId, count }));
    return (
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-extrabold text-ink-muted">
          <FiPackage className="size-4 text-pal" /> {t("背包")}
          <span className="rounded-full bg-card-soft px-2 py-0.5 text-xs font-bold">{rows.length}</span>
        </h3>
        <ItemGrid rows={rows} gameData={gameData} />
      </div>
    );
  }

  const TABS: { id: ItemTab; label: string }[] = [
    { id: "common", label: t("背包") },
    { id: "weapons", label: t("武器") },
    { id: "armor", label: t("防具") },
    { id: "essential", label: t("重要物品") },
    { id: "food", label: t("食物") },
  ];
  const rows = inventory[tab];

  return (
    <div>
      <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
        <FiPackage className="size-4 text-pal" /> {t("物品")}
      </h3>
      <div className="mb-2 flex flex-wrap gap-1">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition ${
              tab === id ? "border-pal bg-pal/10 text-pal" : "border-line text-ink-muted hover:border-ink-muted"
            }`}
          >
            {label}
            <span className={`ml-1 ${tab === id ? "" : "opacity-70"}`}>{inventory[id].length}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="py-3 text-center text-[13px] text-ink-muted">{t("這個分類沒有物品。")}</p>
      ) : (
        <ItemGrid rows={rows} gameData={gameData} />
      )}
    </div>
  );
}

function ItemGrid({ rows, gameData }: { rows: { itemId: string; count: number }[]; gameData: GameData | null }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
      {rows.map(({ itemId, count }, i) => {
        const entity = gameData?.itemById.get(itemId);
        return (
          <div key={`${itemId}-${i}`} className="flex items-center gap-2 rounded-xl border-2 border-line p-2">
            {entity?.icon ? (
              <img src={itemIconUrl(entity.icon)} alt="" className="size-8 shrink-0" />
            ) : (
              <span className="size-8 shrink-0 rounded bg-card-soft" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold">{entity ? displayName(entity) : itemId}</p>
            </div>
            <span className="shrink-0 text-sm font-extrabold text-pal">×{count}</span>
          </div>
        );
      })}
    </div>
  );
}
