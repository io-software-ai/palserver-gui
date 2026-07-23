import { useCallback, useEffect, useRef, useState } from "react";
import { FiRefreshCw, FiMap, FiX, FiHome, FiUsers, FiStar, FiMoon, FiMapPin, FiExternalLink, FiZap, FiGlobe } from "react-icons/fi";
import { GiCrownedSkull } from "react-icons/gi";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  assignReportedBosses,
  bossRespawnInfo,
  bossStateMapCoord,
  dungeonBossInfo,
  guildColorFromId,
  hashSeed,
  isWorldTreeCoord,
  RAID_RADIUS,
  savToMap,
  savToWorldTreeMap,
  type BossRespawnState,
  type BossRespawnStatus,
  type DungeonBossEntry,
  type LiveStatus,
  type RestPlayer,
  type PdGuild,
  type PdGuildDetail,
  type PdPlayerSummary,
  type SaveGuild,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { useGameData, palIconUrl, type GameData } from "./gameData";
import {
  MAP_IMAGE,
  IMAGE_BOUNDS,
  TREE_MAP_IMAGE,
  TREE_IMAGE_BOUNDS,
  LANDMARK_STYLE,
  escapeHtml,
  loadMapLayers,
  type Landmark,
  type Boss,
} from "./mapLayers";
import { PlayerDetailModal } from "./PlayerDetailModal";
import { GuildDetailModal as SaveGuildDetailModal, BasePeekModal, BaseDetailModal } from "./GuildDetailModal";
import { PlayerActionsMenu } from "./PlayerActionsMenu";
import { PublicMapModal } from "./PublicMapModal";
import { t, useI18n } from "./i18n";
import { SHOW_FAST_TRAVEL_UNLOCK } from "./flags";
import { Overlay, btn, btnGhost, card, errorCls } from "./ui";

/**
 * Live player map on the official Palworld world map (palworld.wiki.gg's
 * "Palpagos Islands World Map", which already includes Sakurajima etc.).
 *
 * Rendering is Leaflet with CRS.Simple: the world map coordinate square is the
 * CRS, so a player at savToMap(x,y) → LatLng(mapY, mapX) lands deterministically
 * — no manual calibration or flip toggles. The image is anchored by the exact
 * map-coordinate bounds the wiki's DataMaps publishes for that image, so the
 * whole thing is correct by construction.
 *
 * 底圖常數、頭目/地標型別與樣式現在都在 mapLayers.ts(與 MapPickModal.tsx 傳送選點地圖共用,
 * 避免兩邊各自宣告一份、只靠註解提醒同步而漂移)。
 */

export type MapWorld = "main" | "tree";

/** A distinct, stable colour per guild (so a guild's bases and members match).
 * @palserver/shared 的 guildColorFromId —— 公開地圖發布端(packages/agent/src/public-map.ts)
 * 算據點配色時要用同一顆雜湊,抽到共用套件,這裡改成薄封裝,行為不變。 */
const guildColor = guildColorFromId;

/** Connection-quality colour from ping (ms): green / amber / red. */
function pingColor(ping: number): string {
  if (ping < 80) return "#4fb968";
  if (ping < 150) return "#e0a53f";
  return "#e05b5b";
}

/** 秒數 → H:MM:SS 或 MM:SS。本地複製自 BossRespawnTab.tsx,故意不動 shared 的 public API。 */
function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** Same deterministic "random Pal" avatar as the player list (PlayerAvatar):
 * hash the userId and pick a Pal that has artwork. Returns its icon URL. */
function avatarIconUrl(seed: string, gameData: GameData | null): string | null {
  const withIcons = gameData?.pals.filter((p) => p.icon) ?? [];
  if (!withIcons.length) return null;
  // 雜湊演算法抽到 @palserver/shared 的 hashSeed(公開地圖發布端 pickPalAvatarIcon 用同一顆),
  // 但挑選清單仍是「當下載入的 gameData.pals」(可能被 GitHub raw 背景更新過),不是
  // shared 那份靜態生成清單 —— 這裡的行為必須跟改之前一模一樣。
  const pal = withIcons[hashSeed(seed) % withIcons.length];
  return pal.icon ? palIconUrl(pal.icon) : null;
}

export function MapTab({
  client,
  instanceId,
  fullscreen = false,
  externalFocus = null,
  overlayOnly = false,
  onOverlayClose,
}: {
  client: AgentClient;
  instanceId: string;
  /** 全螢幕模式(/map 獨立頁):地圖直接鋪滿視窗,不套外殼、不需「開啟地圖」入口。 */
  fullscreen?: boolean;
  /** 外部指定的聚焦點(地圖座標;n 遞增觸發)— 玩家詳情「據點跳地圖」用。 */
  externalFocus?: { x: number; y: number; n: number } | null;
  /** 只渲染地圖覆蓋層,不顯示地圖分頁入口卡。 */
  overlayOnly?: boolean;
  onOverlayClose?: () => void;
}) {
  const { lang } = useI18n();
  const gameData = useGameData();
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [guilds, setGuilds] = useState<PdGuild[]>([]);
  const [pdPlayers, setPdPlayers] = useState<PdPlayerSummary[]>([]);
  const [guildsUnlocked, setGuildsUnlocked] = useState(false);
  const [guildDetailId, setGuildDetailId] = useState<string | null>(null);
  const [playerDetail, setPlayerDetail] = useState<{ id: string; label: string } | null>(null);
  // 地圖彈窗只放基礎資訊,「查看完整資料」才開重量級詳情(玩家/公會一致)
  const [playerPeek, setPlayerPeek] = useState<{ id: string; label: string } | null>(null);
  const [guildFull, setGuildFull] = useState<SaveGuild | null>(null);
  const [saveSnap, setSaveSnap] = useState<{ generatedAt: string | null; guilds: SaveGuild[] } | null>(null);
  // 據點三層下鑽:簡單資訊(peek)→ 完整資訊(full)→ 公會資訊(guildFull)。
  type ResolvedBase = { guild: SaveGuild; base: SaveGuild["bases"][number]; index: number };
  const [basePeek, setBasePeek] = useState<ResolvedBase | null>(null);
  const [baseFull, setBaseFull] = useState<ResolvedBase | null>(null);

  /** 點據點 marker:抓存檔快照、依 id(去格式後比對,吸收 PD/存檔 GUID 格式差)找到公會與該據點,開簡單資訊。 */
  const openBasePeek = async (guildId: string, baseId: string) => {
    try {
      const snap = saveSnap ?? (await client.guildsSnapshot(instanceId));
      setSaveSnap(snap);
      const norm = (s: string) => s.replace(/[^0-9a-f]/gi, "").toLowerCase();
      const g = snap.guilds.find((x) => norm(x.id) === norm(guildId));
      if (!g) {
        setError(t("存檔快照裡找不到這個公會 — 到公會分頁「從存檔刷新」重掃一次。"));
        return;
      }
      const index = g.bases.findIndex((b) => norm(b.id) === norm(baseId));
      if (index < 0) {
        setError(t("存檔快照裡找不到這個據點 — 到公會分頁「從存檔刷新」重掃一次。"));
        return;
      }
      setBasePeek({ guild: g, base: g.bases[index], index });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 據點被刪除:從快照移掉、關閉所有據點彈窗,標記快照過期(下次重抓)。 */
  const onBaseDeleted = (baseId: string) => {
    const norm = (s: string) => s.replace(/[^0-9a-f]/gi, "").toLowerCase();
    setGuilds((gs) => gs.map((g) => ({ ...g, bases: g.bases.filter((b) => norm(b.id) !== norm(baseId)) })));
    setSaveSnap(null);
    setBasePeek(null);
    setBaseFull(null);
  };

  /** 懶載入公會快照(第一次點「查看完整資料」時才抓)。 */
  const openGuildFull = async (guildId: string, name: string) => {
    try {
      const snap = saveSnap ?? (await client.guildsSnapshot(instanceId));
      setSaveSnap(snap);
      const norm = (s: string) => s.replace(/[^0-9a-f]/gi, "").toLowerCase();
      const g =
        snap.guilds.find((x) => norm(x.id) === norm(guildId)) ?? snap.guilds.find((x) => x.name === name);
      if (!g) {
        setError(t("存檔快照裡找不到這個公會 — 到公會分頁「從存檔刷新」重掃一次。"));
        return;
      }
      setGuildDetailId(null);
      setGuildFull(g);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(fullscreen);
  const [showPublicMap, setShowPublicMap] = useState(false);
  const [showPlayers, setShowPlayers] = useState(true);
  const [showOffline, setShowOffline] = useState(false);
  const [showBases, setShowBases] = useState(true);
  const [showLandmarks, setShowLandmarks] = useState(false);
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  const [showBosses, setShowBosses] = useState(false);
  const [bosses, setBosses] = useState<Boss[]>([]);
  // 頭目重生狀態(boss-respawn 模組回報;贊助者先行功能,無 feature/模組未安裝時
  // client.bossRespawns 回 supported:false/state:null,疊加層自然不顯示)。
  const [bossRespawns, setBossRespawns] = useState<BossRespawnStatus | null>(null);
  // 世界樹的靜態圖層資料(worldtree-*.json;缺檔=舊資料包,圖層開關自動消失)
  const [treeLandmarks, setTreeLandmarks] = useState<Landmark[]>([]);
  const [treeBosses, setTreeBosses] = useState<Boss[]>([]);
  const [guildHint, setGuildHint] = useState(false);
  // 快速傳送全開(贊助者):寫入所有玩家存檔;需伺服器停止,agent 會先整世界備份
  const [unlocking, setUnlocking] = useState(false);
  const [unlockMsg, setUnlockMsg] = useState<string | null>(null);
  const unlockFastTravel = async () => {
    if (
      !confirm(
        t("把「全部快速傳送點(174 個,含天墜之地)」解鎖給這個世界的所有玩家?") +
          "\n\n" +
          t("需要先停止伺服器;執行前會自動備份整個世界;玩家下次進入伺服器即生效。"),
      )
    )
      return;
    setUnlocking(true);
    setUnlockMsg(null);
    try {
      const r = await client.unlockFastTravel(instanceId);
      const ok = r.players.filter((p) => p.ok).length;
      const failed = r.players.length - ok;
      setUnlockMsg(
        t("已為 {ok} 位玩家解鎖全部 {total} 個快速傳送點。", { ok: String(ok), total: String(r.total) }) +
          (failed > 0 ? " " + t("({n} 個玩家檔失敗,詳見 agent 日誌)", { n: String(failed) }) : ""),
      );
    } catch (err) {
      setUnlockMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlocking(false);
    }
  };
  // 公會詳情點成員 → 地圖跳到該位置。n 是 nonce:同一點連點兩次也要重新觸發。
  const [focus, setFocus] = useState<{ x: number; y: number; n: number } | null>(null);
  // 主世界 / 世界樹(1.0)雙底圖:座標系互相獨立,標記依 isWorldTreeCoord 分流
  const [world, setWorld] = useState<MapWorld>("main");

  // 外部(玩家詳情的據點按鈕)指定聚焦:同步進內部 focus,並確保地圖已展開。
  // 聚焦座標一律是主世界地圖座標,先切回主世界。
  useEffect(() => {
    if (!externalFocus) return;
    setOpen(true);
    setWorld("main");
    setFocus(externalFocus);
  }, [externalFocus]);

  // Static landmark + boss sets (bundled), loaded once;共用 mapLayers.ts 的載入函式
  // (跟 MapPickModal 同一份實作,個別 fetch 失敗給空陣列不擋其他圖層)。
  useEffect(() => {
    void loadMapLayers().then(({ landmarks: lm, bosses: bs, treeLandmarks: tlm, treeBosses: tbs }) => {
      setLandmarks(lm);
      setBosses(bs);
      setTreeLandmarks(tlm);
      setTreeBosses(tbs);
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      setLive(await client.live(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // 公會據點與公會名稱人人可見;detailed=false(非贊助者)只是拿不到成員詳情,
    // 點擊據點走存檔版公會彈窗(guildsUnlocked 控制走 REST 詳情或存檔版)。
    client
      .guilds(instanceId)
      .then((g) => {
        setGuilds(g.available ? g.guilds : []);
        setGuildsUnlocked(g.detailed);
      })
      .catch(() => setGuilds([]));
    // PalDefender 名冊:用來把在線玩家對應到公會(userId 對得上遊戲 REST)。
    client
      .palDefenderPlayers(instanceId)
      .then((r) => setPdPlayers(r.available ? r.players : []))
      .catch(() => setPdPlayers([]));
    // 頭目重生狀態:跟現有 5s poll 走,不加額外 tick;無資料/未授權時 catch 回 null,
    // 疊加層自然不顯示。
    client
      .bossRespawns(instanceId)
      .then(setBossRespawns)
      .catch(() => setBossRespawns(null));
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const curLandmarks = world === "tree" ? treeLandmarks : landmarks;
  const curBosses = world === "tree" ? treeBosses : bosses;

  const baseCount = guilds.reduce((s, g) => s + g.bases.length, 0);
  const offlineCount = pdPlayers.filter(
    (p) => !p.online && p.worldX != null && p.worldY != null,
  ).length;
  const summary = live?.available
    ? t("在線玩家 {n} 人", { n: live.players.length }) + (baseCount > 0 ? ` · ${t("{n} 個公會據點", { n: baseCount })}` : "")
    : (live?.reason ?? t("伺服器未在運作,地圖無法顯示玩家。"));

  const closeOverlay = () => {
    setOpen(false);
    onOverlayClose?.();
  };

  // 地圖面板本體:彈窗與全螢幕頁共用。全螢幕時鋪滿容器、去掉卡片外框與關閉鈕。
  const mapPanel = (
    <div
      className={
        fullscreen
          ? "flex h-full w-full flex-col gap-2 p-3"
          : "flex h-[min(88vh,92vw)] w-[min(88vh,92vw)] max-w-full flex-col gap-2 rounded-(--radius-cute) border-2 border-line bg-card p-3 shadow-(--shadow-cute)"
      }
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-full border-2 border-line">
            {(["main", "tree"] as const).map((w) => (
              <button
                key={w}
                className={
                  world === w
                    ? "bg-pal px-3 py-1.5 text-[13px] font-extrabold text-white"
                    : "bg-card-soft px-3 py-1.5 text-[13px] font-extrabold text-ink-muted transition hover:text-pal"
                }
                onClick={() => setWorld(w)}
              >
                {w === "main" ? t("主世界") : t("世界樹")}
              </button>
            ))}
          </div>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5 ${showPlayers ? "border-pal text-pal" : "opacity-60"}`}
            onClick={() => setShowPlayers((v) => !v)}
          >
            <FiUsers className="size-4" /> {t("玩家")}
          </button>
          {offlineCount > 0 && (
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5 ${showOffline ? "border-pal text-pal" : "opacity-60"}`}
              onClick={() => setShowOffline((v) => !v)}
            >
              <FiMoon className="size-4" /> {t("離線玩家")}
            </button>
          )}
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5 ${showBases ? "border-pal text-pal" : "opacity-60"}`}
            onClick={() => setShowBases((v) => !v)}
          >
            <FiHome className="size-4" /> {t("公會據點")}
          </button>
          {curLandmarks.length > 0 &&
            (guildsUnlocked ? (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5 ${showLandmarks ? "border-pal text-pal" : "opacity-60"}`}
                onClick={() => setShowLandmarks((v) => !v)}
              >
                <FiMapPin className="size-4" /> {t("地標")}
                <FiStar className="size-3.5 text-pal" />
              </button>
            ) : (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5 opacity-70`}
                title={t("此功能為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
                onClick={() => setGuildHint((v) => !v)}
              >
                <FiMapPin className="size-4" /> {t("地標")}
                <FiStar className="size-3.5 text-pal" />
              </button>
            ))}
          {curBosses.length > 0 &&
            (guildsUnlocked ? (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5 ${showBosses ? "border-pal text-pal" : "opacity-60"}`}
                onClick={() => setShowBosses((v) => !v)}
              >
                <GiCrownedSkull className="size-4" /> {t("頭目")}
                <FiStar className="size-3.5 text-pal" />
              </button>
            ) : (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5 opacity-70`}
                title={t("此功能為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
                onClick={() => setGuildHint((v) => !v)}
              >
                <GiCrownedSkull className="size-4" /> {t("頭目")}
                <FiStar className="size-3.5 text-pal" />
              </button>
            ))}
        </div>
        <div className="flex gap-2">
          {!fullscreen && (
            <button
              className={btnGhost}
              onClick={() =>
                window.open(`/map?instance=${encodeURIComponent(instanceId)}`, "_blank", "noopener")
              }
              aria-label={t("在新分頁開啟全螢幕地圖")}
              title={t("在新分頁開啟全螢幕地圖")}
            >
              <FiExternalLink className="size-4" />
            </button>
          )}
          <button className={btnGhost} onClick={refresh} aria-label={t("重新整理")}>
            <FiRefreshCw className="size-4" />
          </button>
          {!fullscreen && (
            <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={closeOverlay}>
              <FiX className="size-4" /> {t("關閉")}
            </button>
          )}
        </div>
      </div>
      {guildHint && !guildsUnlocked && (
        <p className="rounded-xl bg-sun/15 px-3 py-2 text-[13px] font-bold text-sun">
          {t("此功能為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl">
        <PlayerMap
          world={world}
          players={live?.available ? live.players : []}
          guilds={guilds}
          pdPlayers={pdPlayers}
          landmarks={curLandmarks}
          bosses={curBosses}
          bossState={bossRespawns?.state ?? null}
          focus={focus}
          lang={lang}
          showPlayers={showPlayers}
          showOffline={showOffline}
          showBases={showBases}
          showLandmarks={showLandmarks}
          showBosses={showBosses}
          gameData={gameData}
          onGuildClick={(id) => {
            // 免費用戶:REST 公會詳情被 agent 端 403(guild-map),直接走存檔版
            // 公會彈窗(基礎資訊免費、詳細資訊在開關內引導贊助)
            if (guildsUnlocked) setGuildDetailId(id);
            else void openGuildFull(id, "");
          }}
          onBaseClick={(guildId, baseId) => void openBasePeek(guildId, baseId)}
          onPlayerClick={(id, label) => setPlayerPeek({ id, label })}
        />
      </div>
    </div>
  );

  const modals = (
    <>
      {guildDetailId && (
        <GuildDetailModal
          client={client}
          instanceId={instanceId}
          guildId={guildDetailId}
          gameData={gameData}
          pdPlayers={pdPlayers}
          livePlayers={live?.available ? live.players : []}
          onLocate={(pt) => {
            setGuildDetailId(null);
            setFocus({ ...pt, n: Date.now() });
          }}
          onOpenDetail={(name) => void openGuildFull(guildDetailId, name)}
          onClose={() => setGuildDetailId(null)}
        />
      )}
      {guildFull && (
        <SaveGuildDetailModal
          client={client}
          instanceId={instanceId}
          guild={guildFull}
          generatedAt={saveSnap?.generatedAt ?? null}
          onRescanned={() => setSaveSnap(null)}
          onShowOnMap={(x, y) => {
            setGuildFull(null);
            setFocus({ x, y, n: Date.now() });
          }}
          onClose={() => setGuildFull(null)}
        />
      )}
      {basePeek && (
        <BasePeekModal
          guild={basePeek.guild}
          base={basePeek.base}
          baseIndex={basePeek.index}
          onOpenDetail={() => {
            setBaseFull(basePeek);
            setBasePeek(null);
          }}
          onClose={() => setBasePeek(null)}
        />
      )}
      {baseFull && (
        <BaseDetailModal
          client={client}
          instanceId={instanceId}
          guild={baseFull.guild}
          base={baseFull.base}
          baseIndex={baseFull.index}
          onShowOnMap={(x, y) => {
            setBaseFull(null);
            setFocus({ x, y, n: Date.now() });
          }}
          onOpenGuild={() => {
            setGuildFull(baseFull.guild);
            setBaseFull(null);
          }}
          onDeleted={onBaseDeleted}
          onClose={() => setBaseFull(null)}
        />
      )}
      {playerPeek && (
        <PlayerPeekModal
          peek={playerPeek}
          client={client}
          instanceId={instanceId}
          live={live}
          pdPlayers={pdPlayers}
          gameData={gameData}
          onOpenDetail={() => {
            setPlayerDetail(playerPeek);
            setPlayerPeek(null);
          }}
          onClose={() => setPlayerPeek(null)}
        />
      )}
      {playerDetail && (
        <PlayerDetailModal
          client={client}
          instanceId={instanceId}
          identifier={playerDetail.id}
          displayLabel={playerDetail.label}
          onClose={() => setPlayerDetail(null)}
        />
      )}
      {showPublicMap && (
        <PublicMapModal client={client} instanceId={instanceId} onClose={() => setShowPublicMap(false)} />
      )}
    </>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 flex flex-col bg-bg">
        {error && <p className={`${errorCls} m-3`}>{error}</p>}
        {mapPanel ?? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-ink-muted">
            {summary}
          </div>
        )}
        {modals}
      </div>
    );
  }

  if (overlayOnly) {
    return (
      <>
        {open && mapPanel && <Overlay onClose={closeOverlay}>{mapPanel}</Overlay>}
        {modals}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className={errorCls}>{error}</p>}

      {/* 分頁只放入口;地圖在方形彈窗裡開(大小=地圖本身)。 */}
      <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div className="min-w-0">
          <p className="inline-flex items-center gap-2 text-sm font-extrabold">
            <FiMap className="size-4 text-pal" /> {t("線上地圖")}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-muted">{summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {SHOW_FAST_TRAVEL_UNLOCK && (guildsUnlocked ? (
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5`}
              onClick={() => void unlockFastTravel()}
              disabled={unlocking}
              title={t("把全部快速傳送點解鎖給所有玩家(寫入玩家存檔;需伺服器停止,會先自動備份)")}
            >
              <FiZap className="size-4" /> {unlocking ? t("解鎖中…") : t("快速傳送全開")}
              <FiStar className="size-3.5 text-pal" />
            </button>
          ) : (
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5 opacity-70`}
              title={t("此功能為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
              onClick={() => setUnlockMsg(t("此功能為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。"))}
            >
              <FiZap className="size-4" /> {t("快速傳送全開")}
              <FiStar className="size-3.5 text-pal" />
            </button>
          ))}
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setShowPublicMap(true)}
          >
            <FiGlobe className="size-4" /> {t("公開地圖")}
            <FiStar className="size-3.5 text-pal" />
          </button>
          <button
            className={`${btn} inline-flex items-center gap-1.5`}
            onClick={() => setOpen(true)}
            disabled={!live?.available}
          >
            <FiMap className="size-4" /> {t("開啟地圖")}
          </button>
        </div>
      </div>

      {unlockMsg && (
        <p className="rounded-xl bg-card-soft px-3 py-2 text-[13px] font-bold">{unlockMsg}</p>
      )}

      {open && mapPanel && <Overlay onClose={closeOverlay}>{mapPanel}</Overlay>}

      {modals}
    </div>
  );
}

/** 公會詳情彈窗(贊助者):成員名單 + 據點,取自 PalDefender /guild/{id}。
 * 成員顯示與地圖/玩家列表同款的帕魯頭像(seed=userId,靠 pdPlayers 名冊把
 * playerUid 對回 userId;對不上才退用 playerUid)。在線成員可點:回報地圖
 * 座標給父層跳轉(位置優先取遊戲 REST 即時座標,退而求其次用名冊的最後存檔位置)。 */
/** 地圖上的玩家小卡:基礎資訊(在線/等級/座標)+ 操作選單 +「查看完整資料」。 */
function PlayerPeekModal({
  peek,
  client,
  instanceId,
  live,
  pdPlayers,
  gameData,
  onOpenDetail,
  onClose,
}: {
  peek: { id: string; label: string };
  client: AgentClient;
  instanceId: string;
  live: LiveStatus | null;
  pdPlayers: PdPlayerSummary[];
  gameData: GameData | null;
  onOpenDetail: () => void;
  onClose: () => void;
}) {
  useI18n();
  const rp = live?.available
    ? live.players.find((p) => p.userId === peek.id || p.playerId === peek.id || p.name === peek.label)
    : undefined;
  const pp = pdPlayers.find((p) => p.userId === peek.id || p.playerUid === peek.id || p.name === peek.label);
  const iconUrl = avatarIconUrl(peek.id, gameData);
  const online = !!rp || !!pp?.online;

  return (
    <Overlay onClose={onClose}>
      <div className={`${card} flex w-96 max-w-full flex-col gap-3`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-line bg-card-soft">
              {iconUrl ? <img src={iconUrl} alt="" className="size-full object-cover" /> : null}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-extrabold">{peek.label}</p>
              <p className="text-xs text-ink-muted">
                <span className={`font-bold ${online ? "text-grass" : ""}`}>{online ? t("在線") : t("離線")}</span>
                {rp && <> · Lv.{rp.level} · {rp.ping.toFixed(0)}ms</>}
                {pp?.guildName && <> · {pp.guildName}</>}
              </p>
            </div>
          </div>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <PlayerActionsMenu client={client} instanceId={instanceId} userId={peek.id} displayLabel={peek.label} />
          <button className={`${btn} inline-flex flex-1 items-center justify-center gap-1.5`} onClick={onOpenDetail}>
            <FiUsers className="size-3.5" /> {t("查看完整資料")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function GuildDetailModal({
  client,
  instanceId,
  guildId,
  gameData,
  pdPlayers,
  livePlayers,
  onLocate,
  onOpenDetail,
  onClose,
}: {
  client: AgentClient;
  instanceId: string;
  guildId: string;
  gameData: GameData | null;
  pdPlayers: PdPlayerSummary[];
  livePlayers: RestPlayer[];
  onLocate: (pt: { x: number; y: number }) => void;
  /** 開「完整公會資料」(存檔快照彈窗);參數為公會名(id 對不到時備援比對用) */
  onOpenDetail?: (name: string) => void;
  onClose: () => void;
}) {
  useI18n();
  const [detail, setDetail] = useState<PdGuildDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .guild(instanceId, guildId)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [client, instanceId, guildId]);

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[85vh] w-[560px] max-w-full flex-col gap-4 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="inline-flex items-center gap-2 truncate text-lg font-extrabold">
            <FiHome className="size-5 text-pal" /> {detail?.name || t("公會詳情")}
          </h2>
          <div className="flex items-center gap-2">
            {onOpenDetail && detail?.available && (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5`}
                onClick={() => onOpenDetail(detail.name)}
                title={t("倉庫、駐守帕魯與研究進度(來自存檔快照)")}
              >
                {t("查看完整資料")}
              </button>
            )}
            <button className={btnGhost} onClick={onClose}>
              <FiX className="inline size-4" /> {t("關閉")}
            </button>
          </div>
        </div>

        {error && <p className={errorCls}>{error}</p>}
        {!detail && !error && <p className="text-ink-muted">{t("載入中…")}</p>}
        {detail && !detail.available && <p className={errorCls}>{detail.reason ?? t("讀取失敗")}</p>}

        {detail?.available && (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <Info label={t("等級")} value={`Lv.${detail.level}`} />
              <Info label={t("會長")} value={detail.adminName || "—"} />
              <Info label={t("成員數")} value={String(detail.memberCount)} />
            </div>

            <div>
              <h3 className="mb-1 text-sm font-extrabold text-ink-muted">
                {t("成員")}({detail.members.length})
              </h3>
              <div className="flex flex-col divide-y divide-line">
                {detail.members.map((m) => {
                  const online = m.status.toLowerCase() === "online";
                  const pp = pdPlayers.find((p) => p.playerUid === m.playerUid);
                  const iconUrl = avatarIconUrl(pp?.userId || m.playerUid, gameData);
                  // 在線成員的地圖位置:遊戲 REST 即時座標優先,名冊最後存檔位置兜底。
                  const rp = online
                    ? livePlayers.find(
                        (p) =>
                          p.userId === m.playerUid ||
                          p.playerId === m.playerUid ||
                          (pp?.userId != null && (p.userId === pp.userId || p.playerId === pp.userId)) ||
                          (!!m.name && p.name === m.name),
                      )
                    : undefined;
                  const pos = rp
                    ? savToMap(rp.location_x, rp.location_y)
                    : online && pp?.worldX != null && pp?.worldY != null
                      ? savToMap(pp.worldX, pp.worldY)
                      : null;
                  const row = (
                    <>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-line bg-card-soft">
                          {iconUrl ? <img src={iconUrl} alt="" className="size-full object-cover" /> : null}
                        </span>
                        <span className="min-w-0 truncate font-bold">{m.name || "—"}</span>
                        {pos && <FiMapPin className="size-3.5 shrink-0 text-pal" />}
                      </span>
                      <span className={`shrink-0 text-xs font-bold ${online ? "text-grass" : "text-ink-muted"}`}>
                        {online ? t("在線") : t("離線")}
                      </span>
                    </>
                  );
                  return pos ? (
                    <button
                      key={m.playerUid}
                      type="button"
                      title={t("跳到地圖位置")}
                      className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-left text-sm transition hover:text-pal"
                      onClick={() => onLocate(pos)}
                    >
                      {row}
                    </button>
                  ) : (
                    <div key={m.playerUid} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                      {row}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 className="mb-1 text-sm font-extrabold text-ink-muted">
                {t("據點")}({detail.camps.length})
              </h3>
              <div className="flex flex-col divide-y divide-line">
                {detail.camps.map((c) => {
                  const m = savToMap(c.worldX, c.worldY);
                  return (
                    <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="min-w-0 font-bold">
                        Lv.{c.level}
                        {c.state ? <span className="ml-2 text-xs font-normal text-ink-muted">{c.state}</span> : null}
                      </span>
                      <span className="shrink-0 text-xs text-ink-muted">
                        {Math.round(m.x)}, {Math.round(m.y)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </Overlay>
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

/** Leaflet CRS.Simple map + avatar markers for players and base markers for
 * guilds (both from savToMap, so they share the players' coordinate frame). */
function PlayerMap({
  world,
  players,
  guilds,
  pdPlayers,
  landmarks,
  bosses,
  bossState,
  focus,
  lang,
  showPlayers,
  showOffline,
  showBases,
  showLandmarks,
  showBosses,
  gameData,
  onGuildClick,
  onBaseClick,
  onPlayerClick,
}: {
  world: MapWorld;
  players: RestPlayer[];
  guilds: PdGuild[];
  /** PalDefender /players roster — matches live players to their guild, and
   * (when showOffline) provides offline players' last-saved positions. */
  pdPlayers: PdPlayerSummary[];
  landmarks: Landmark[];
  bosses: Boss[];
  /** 頭目重生模組回報的最新狀態(null=無資料/未授權/模組未安裝;疊加層自然不顯示)。 */
  bossState: BossRespawnState | null;
  /** 公會詳情點成員後要跳到的地圖座標(n 為 nonce,同點重點也會觸發)。 */
  focus: { x: number; y: number; n: number } | null;
  lang: "zh" | "zh-CN" | "en" | "ja";
  showPlayers: boolean;
  showOffline: boolean;
  showBases: boolean;
  showLandmarks: boolean;
  showBosses: boolean;
  gameData: GameData | null;
  onGuildClick?: (guildId: string) => void;
  /** 點據點 marker:開該據點的簡單資訊(三層下鑽第一層)。 */
  onBaseClick?: (guildId: string, baseId: string) => void;
  /** Open the full player-detail view (same as the player list). */
  onPlayerClick?: (userId: string, name: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  /** 目前底圖邊界(applySize 與 world 切換共用) */
  const boundsRef = useRef<L.LatLngBounds>(IMAGE_BOUNDS);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const onGuildClickRef = useRef(onGuildClick);
  onGuildClickRef.current = onGuildClick;
  const onBaseClickRef = useRef(onBaseClick);
  onBaseClickRef.current = onBaseClick;
  const onPlayerClickRef = useRef(onPlayerClick);
  onPlayerClickRef.current = onPlayerClick;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el, {
      crs: L.CRS.Simple,
      attributionControl: false,
      zoomSnap: 0.25,
      maxZoom: 4,
    });
    map.setView(IMAGE_BOUNDS.getCenter(), -2); // provisional view; applySize refits properly
    el.style.background = "transparent"; // let the card bg show past the image instead of Leaflet's grey
    // 底圖與邊界由 world effect 掛(主世界/世界樹切換共用同一條路徑)
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // The square container's height comes from layout and may be 0 on the first
    // run, which makes fitBounds/min-zoom wrong. Compute both against the real
    // size (via ResizeObserver), and set min-zoom a level below the full-map fit
    // so you can always zoom all the way out. Refit the view only once.
    let fitted = false;
    const applySize = () => {
      map.invalidateSize();
      if (map.getSize().y === 0) return;
      map.setMinZoom(map.getBoundsZoom(boundsRef.current) - 1);
      if (!fitted) {
        map.fitBounds(boundsRef.current);
        fitted = true;
      }
    };
    const ro = new ResizeObserver(applySize);
    ro.observe(el);
    applySize();

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // 底圖切換(主世界 / 世界樹):換 overlay 與邊界,重新 fit。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = world === "tree" ? TREE_IMAGE_BOUNDS : IMAGE_BOUNDS;
    boundsRef.current = bounds;
    const overlay = L.imageOverlay(world === "tree" ? TREE_MAP_IMAGE : MAP_IMAGE, bounds).addTo(map);
    overlay.bringToBack(); // 壓在標記層之下
    map.setMaxBounds(bounds.pad(0.3));
    if (map.getSize().y > 0) {
      map.setMinZoom(map.getBoundsZoom(bounds) - 1);
      map.fitBounds(bounds);
    }
    return () => {
      map.removeLayer(overlay);
    };
  }, [world]);

  // 公會詳情跳轉:飛到成員位置並拉近(已經更近就維持現有縮放)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.flyTo([focus.y, focus.x], Math.max(map.getZoom(), 1), { duration: 0.8 });
  }, [focus]);

  useEffect(() => {
    const group = markersRef.current;
    if (!group) return;
    group.clearLayers();
    const SIZE = 40;

    // 座標分流:實體在哪個世界(isWorldTreeCoord)必須等於目前檢視的世界,
    // 否則回 null 不畫 —— 世界樹玩家用主世界公式會畫到圖外,反之亦然。
    const project = (sx: number, sy: number): { x: number; y: number } | null => {
      if (isWorldTreeCoord(sx) !== (world === "tree")) return null;
      return world === "tree" ? savToWorldTreeMap(sx, sy) : savToMap(sx, sy);
    };

    // Match each live player to their guild. The game REST player ids
    // (playerId/userId) don't line up with PalDefender's guild-member PlayerUIDs,
    // so match via PalDefender /players instead — it carries both the userId that
    // matches the game REST player AND the guild name. Fall back to the member
    // UID list only if we have no /players record.
    const guildByName = new Map(guilds.map((g) => [g.name, g] as const));
    const guildNameById = new Map<string, string>();
    for (const pp of pdPlayers) {
      if (!pp.guildName) continue;
      if (pp.userId) guildNameById.set(pp.userId, pp.guildName);
      if (pp.playerUid) guildNameById.set(pp.playerUid, pp.guildName);
    }
    const guildByMember = new Map<string, PdGuild>();
    for (const g of guilds) for (const uid of g.members) guildByMember.set(uid, g);
    const guildOf = (p: RestPlayer): PdGuild | undefined => {
      const gn = guildNameById.get(p.userId) ?? guildNameById.get(p.playerId);
      return (gn ? guildByName.get(gn) : undefined) ?? guildByMember.get(p.playerId) ?? guildByMember.get(p.userId);
    };

    // All bases in map coords, for the raid-proximity check. (Independent of the
    // base-marker toggle — a player near an enemy base is flagged regardless.)
    const allBases = guilds.flatMap((g) =>
      g.bases
        .map((b) => {
          const pos = project(b.worldX, b.worldY);
          return pos ? { ...pos, guildId: g.id, guildName: g.name } : null;
        })
        .filter((b): b is { x: number; y: number; guildId: string; guildName: string } => b !== null),
    );
    /** Name of a *different* guild whose base this point sits near, else null. */
    const enemyBaseNear = (px: number, py: number, ownGuildId?: string): string | null => {
      for (const b of allBases) {
        if (b.guildId === ownGuildId) continue;
        if (Math.hypot(b.x - px, b.y - py) < RAID_RADIUS) return b.guildName;
      }
      return null;
    };

    // Static landmarks (fast travel / towers / dungeons) as the bottom layer,
    // each with its own game compass icon.
    if (showLandmarks) {
      for (const lm of landmarks) {
        const style = LANDMARK_STYLE[lm.type];
        if (!style) continue;
        const icon = L.icon({
          iconUrl: style.icon,
          iconSize: [style.size, style.size],
          iconAnchor: [style.size / 2, style.size / 2],
          className: "pmap-landmark",
        });
        L.marker([lm.y, lm.x], { icon })
          .bindTooltip(
            `<div style="font-weight:800">${escapeHtml(
              (lang === "zh-CN" ? lm.name["zh-CN"] ?? lm.name.zhCN : lm.name[lang]) || lm.name.en,
            )}</div>` +
              `<div>${t(style.label)}${lm.lv ? ` · Lv.${lm.lv}` : ""}</div>`,
            { direction: "top", className: "pmap-detail" },
          )
          .addTo(group);
      }
    }

    // Bosses: a distinct framed Pal portrait with a badge + level —
    // deliberately unlike the round guild-ringed player avatars (no ping) and
    // separate from the landmark layer. Two kinds, styled so they read apart
    // on the map at a glance (like palworld.gg): field-spawn Alpha Pals get
    // the original red frame + crown badge; Sealed Realm bosses get a violet
    // frame + a diamond/portal badge instead of the crown.
    if (showBosses) {
      const BS = 36;
      // 疊加頭目重生狀態:依世界分池配對(主世界/世界樹地圖座標都是 ±1000 會撞號),
      // 一對一最近指派,跟 BossRespawnTab 用同一套 shared 純函式與規則(見 boss-respawn.ts)。
      const reportedBosses = bossState?.bosses ?? [];
      const bossPool = reportedBosses.filter((e) => isWorldTreeCoord(e.x) === (world === "tree"));
      const bossAssign = assignReportedBosses(bosses, bossPool);
      // 地下城頭目也在 bosses.json 內(與野外/封印頭目同座標);它們的重生時間來自 state.dungeons,
      // 另外按座標近鄰配對疊到同一份 marker 上。野外配到就用野外,沒配到才看地下城。
      const reportedDungeons = bossState?.dungeons ?? [];
      const nowSec = Math.floor(Date.now() / 1000);
      const dungeonInfoFor = (bb: Boss) => {
        let best: DungeonBossEntry | null = null;
        let bd = 40;
        for (const d of reportedDungeons) {
          const m = bossStateMapCoord(d);
          const dist = Math.hypot(m.x - bb.x, m.y - bb.y);
          if (dist <= bd) {
            bd = dist;
            best = d;
          }
        }
        return best ? dungeonBossInfo(best, nowSec) : null;
      };
      for (const b of bosses) {
        const sealed = b.kind === "sealed";
        const iconUrl = b.icon ? palIconUrl(b.icon) : null;
        const wild = bossRespawnInfo(bossAssign.get(b) ?? null, nowSec);
        const dungeon = wild.status === "unknown" ? dungeonInfoFor(b) : null;
        const dead = wild.status === "dead" || dungeon?.status === "dead";
        const secondsLeft = wild.status === "dead" ? wild.secondsLeft : dungeon?.secondsLeft ?? null;
        const icon = L.divIcon({
          className: "pmap-boss-wrap",
          iconSize: [BS, BS],
          iconAnchor: [BS / 2, BS / 2],
          tooltipAnchor: [0, -BS / 2],
          html:
            `<span class="pmap-boss${sealed ? " pmap-boss-sealed" : ""}${dead ? " pmap-boss-dead" : ""}" style="width:${BS}px;height:${BS}px">` +
            (iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="" />` : "") +
            `<span class="pmap-boss-badge${sealed ? " pmap-boss-badge-sealed" : ""}">` +
            (sealed
              ? `<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M12 2 22 12 12 22 2 12z"/></svg>`
              : `<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M4 17l-2-10 5.5 4L12 4l4.5 7L22 7l-2 10z"/></svg>`) +
            `</span>` +
            (b.lv ? `<span class="pmap-boss-lv${sealed ? " pmap-boss-lv-sealed" : ""}">${b.lv}</span>` : "") +
            `</span>`,
        });
        L.marker([b.y, b.x], { icon, riseOnHover: true })
          .bindTooltip(
            `<div style="font-weight:800">${escapeHtml(
              (lang === "zh-CN" ? b.name["zh-CN"] ?? b.name.zhCN : b.name[lang]) || b.name.en,
            )}</div>` +
              `<div>${t(sealed ? "封印領域" : "阿爾法")}${b.lv ? ` · Lv.${b.lv}` : ""}</div>` +
              (dead
                ? `<div>${
                    secondsLeft === null
                      ? t("約下個遊戲日重生")
                      : secondsLeft > 0
                        ? t("重生倒數 {c}", { c: fmtCountdown(secondsLeft) })
                        : t("應已重生")
                  }</div>`
                : ""),
            { direction: "top", className: "pmap-detail" },
          )
          .addTo(group);
      }
    }

    // Guild bases first (under players). world_pos → savToMap, same frame.
    // The whole guild feature is sponsor-only, so if we have any guild data the
    // viewer is a sponsor — bases are always coloured, named, and clickable.
    // Marker = the in-game Palbox art on a guild-coloured ring.
    if (showBases) {
      for (const g of guilds) {
        const color = guildColor(g.id);
        for (const b of g.bases) {
          const pos = project(b.worldX, b.worldY);
          if (!pos) continue;
          const { x, y } = pos;
          const icon = L.divIcon({
            className: "pmap-base-wrap",
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            tooltipAnchor: [0, -16],
            html:
              `<span class="pmap-base" style="border-color:${color}">` +
              `<img src="/game-data/landmark-icons/palbox.webp" alt="" />` +
              `</span>`,
          });
          const marker = L.marker([y, x], { icon });
          marker.bindTooltip(
            `<div style="font-weight:800">${escapeHtml(g.name || "—")}</div>` +
              `<div>${t("公會據點")} · Lv.${g.level} · ${t("{n} 名成員", { n: g.memberCount })}</div>`,
            { direction: "top", className: "pmap-detail" },
          );
          marker.on("click", () => onBaseClickRef.current?.(g.id, b.id));
          marker.addTo(group);
        }
      }
    }

    // Offline players at their last-saved position (dimmed avatars). Skip anyone
    // currently online (they're drawn live below) and anyone without a position.
    if (showOffline) {
      const onlineIds = new Set<string>();
      for (const p of players) {
        onlineIds.add(p.userId);
        onlineIds.add(p.playerId);
      }
      for (const pp of pdPlayers) {
        if (pp.online || pp.worldX == null || pp.worldY == null) continue;
        if (onlineIds.has(pp.userId) || onlineIds.has(pp.playerUid)) continue;
        const pos = project(pp.worldX, pp.worldY);
        if (!pos) continue;
        const { x, y } = pos;
        const iconUrl = avatarIconUrl(pp.userId, gameData);
        const guild = pp.guildName ? guildByName.get(pp.guildName) : undefined;
        const ring = guild ? guildColor(guild.id) : "#8a94a3";
        const icon = L.divIcon({
          className: "pmap-avatar-wrap",
          iconSize: [SIZE, SIZE],
          iconAnchor: [SIZE / 2, SIZE / 2],
          tooltipAnchor: [0, -SIZE / 2],
          html: `<span class="pmap-avatar pmap-offline" style="width:${SIZE}px;height:${SIZE}px;border-color:${ring}">${
            iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="" />` : ""
          }</span>`,
        });
        const marker = L.marker([y, x], { icon, riseOnHover: true });
        marker.bindTooltip(
          `<div style="font-weight:800">${escapeHtml(pp.name || "—")}</div>` +
            (pp.guildName ? `<div style="color:${ring}">${escapeHtml(pp.guildName)}</div>` : "") +
            `<div>${t("離線")} · ${t("最後位置")} ${Math.round(x)}, ${Math.round(y)}</div>`,
          { direction: "top", className: "pmap-detail" },
        );
        marker.on("click", () => onPlayerClickRef.current?.(pp.userId, pp.name));
        marker.addTo(group);
      }
    }

    if (showPlayers)
      for (const p of players) {
        const pos = project(p.location_x, p.location_y);
        if (!pos) continue;
        const { x, y } = pos;
        const iconUrl = avatarIconUrl(p.userId, gameData);
        const guild = guildOf(p);
        // Only flag a raid when we actually know the player's guild — otherwise
        // an unmatched player would be "near" every base, including their own.
        const raidingGuild = guild ? enemyBaseNear(x, y, guild.id) : null;
        const ring = guild ? guildColor(guild.id) : "#ffffff";
        const png = pingColor(p.ping);
        // A round Pal-avatar pin (same random Pal as the player list), built as a
        // div-icon so it can hold an <img>. Border = guild colour; a corner dot
        // shows connection quality (ping); a red halo flags a possible raid
        // (standing near another guild's base). Details show on hover.
        const icon = L.divIcon({
          className: "pmap-avatar-wrap",
          iconSize: [SIZE, SIZE],
          iconAnchor: [SIZE / 2, SIZE / 2],
          tooltipAnchor: [0, -SIZE / 2],
          html:
            `<span class="pmap-avatar${raidingGuild ? " pmap-raid" : ""}" style="width:${SIZE}px;height:${SIZE}px;border-color:${ring}">` +
            (iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="" />` : "") +
            `<i class="pmap-ping" style="background:${png}"></i>` +
            `</span>`,
        });
        const marker = L.marker([y, x], { icon, riseOnHover: true });
        marker.bindTooltip(
          `<div style="font-weight:800">${escapeHtml(p.name || "—")}</div>` +
            (guild ? `<div style="color:${ring}">${escapeHtml(guild.name)}</div>` : "") +
            `<div>${t("座標")} ${Math.round(x)}, ${Math.round(y)} · Lv.${p.level} · ${Math.round(p.ping)}ms</div>` +
            (raidingGuild
              ? `<div style="color:#e05b5b;font-weight:700">${t("靠近他人據點:{name}", { name: escapeHtml(raidingGuild) })}</div>`
              : ""),
          { direction: "top", className: "pmap-detail" },
        );
        marker.on("click", () => onPlayerClickRef.current?.(p.userId, p.name));
        group.addLayer(marker);
      }
  }, [
    players,
    guilds,
    pdPlayers,
    landmarks,
    bosses,
    bossState,
    lang,
    showPlayers,
    showOffline,
    showBases,
    showLandmarks,
    showBosses,
    gameData,
    world,
  ]);

  return <div ref={containerRef} className="h-full w-full rounded-xl bg-card-soft" />;
}
