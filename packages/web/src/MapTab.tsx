import { useCallback, useEffect, useRef, useState } from "react";
import { FiRefreshCw, FiMap, FiX, FiHome, FiUsers, FiStar, FiMoon, FiMapPin, FiExternalLink } from "react-icons/fi";
import { GiCrownedSkull, GiMinerals } from "react-icons/gi";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  savToMap,
  type LiveStatus,
  type RestPlayer,
  type PdGuild,
  type PdGuildDetail,
  type PdPlayerSummary,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { useGameData, palIconUrl, type GameData } from "./gameData";
import { PlayerDetailModal } from "./PlayerDetailModal";
import { t, useI18n } from "./i18n";
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
 */
const MAP_IMAGE = "/palworld-full-map.jpg";

/**
 * Full world map (Palpagos + Sakurajima + Feybreak), stitched from palworld.gg's
 * map tiles. It covers the game's full land-texture bounds, world
 * X∈[-1099400, 349400], Y∈[-724400, 724400]. Converted through savToMap
 * (mapX=(worldY-158000)/459, mapY=(worldX+123888)/459) that is, in our map coord
 * system, mapX∈[-1922.44, 1233.99], mapY∈[-2125.30, 1031.13]. CRS.Simple uses
 * [lat,lng] = [mapY (north), mapX (east)] → [[south, west], [north, east]].
 * Verified: Mt Obsidian, the snow island and Sakurajima all land in-region.
 */
const IMAGE_BOUNDS = L.latLngBounds([-2125.3, -1922.44], [1031.13, 1233.99]);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** A distinct, stable colour per guild (so a guild's bases and members match). */
function guildColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 70% 52%)`;
}

/** Connection-quality colour from ping (ms): green / amber / red. */
function pingColor(ping: number): string {
  if (ping < 80) return "#4fb968";
  if (ping < 150) return "#e0a53f";
  return "#e05b5b";
}

/** How close (in map units, ±1000 span) an online player must be to a base of
 * a *different* guild to flag a possible raid. */
const RAID_RADIUS = 70;

/** Static landmarks (from paldb.cc's map data; ipos is already in our map coord
 * system). type → colour + i18n label key. */
interface Landmark {
  type: string;
  /** Name per interface language (from paldb's per-locale map data). */
  name: { en: string; zh: string; ja: string; zhCN?: string };
  x: number;
  y: number;
  lv?: number;
}
const LANDMARK_STYLE: Record<string, { icon: string; size: number; label: string }> = {
  "Fast Travel": { icon: "/game-data/landmark-icons/fasttravel.png", size: 26, label: "快速旅行" },
  Tower: { icon: "/game-data/landmark-icons/tower.png", size: 30, label: "頭目塔" },
  Dungeon: { icon: "/game-data/landmark-icons/dungeon.png", size: 22, label: "地牢" },
};

/** Field bosses (Alpha Pals) from paldb.cc's map data — a separate layer from
 * landmarks. Each carries the Pal's portrait icon (shared with pals/) so the
 * marker shows which boss it is; ipos is already in our map coord system. */
interface Boss {
  name: { en: string; zh: string; ja: string; zhCN?: string };
  x: number;
  y: number;
  lv?: number;
  /** Pal portrait filename within game-data/pals/, if we have artwork. */
  icon?: string;
}

/** Ore/mineral nodes (from paldb.cc's map data via scripts/fetch-map-ores.mjs).
 * ~3.9k points — far too many for DOM markers, so the layer renders them as
 * canvas circle markers coloured per ore type; names/colours ride in the file. */
interface OreData {
  types: Record<string, { name: { en: string; zh: string; ja: string; zhCN?: string }; icon: string; color: string; big?: boolean }>;
  spots: { t: string; x: number; y: number }[];
}

/** Same deterministic "random Pal" avatar as the player list (PlayerAvatar):
 * hash the userId and pick a Pal that has artwork. Returns its icon URL. */
function avatarIconUrl(seed: string, gameData: GameData | null): string | null {
  const withIcons = gameData?.pals.filter((p) => p.icon) ?? [];
  if (!withIcons.length) return null;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const pal = withIcons[hash % withIcons.length];
  return pal.icon ? palIconUrl(pal.icon) : null;
}

export function MapTab({
  client,
  instanceId,
  fullscreen = false,
}: {
  client: AgentClient;
  instanceId: string;
  /** 全螢幕模式(/map 獨立頁):地圖直接鋪滿視窗,不套外殼、不需「開啟地圖」入口。 */
  fullscreen?: boolean;
}) {
  const { lang } = useI18n();
  const gameData = useGameData();
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [guilds, setGuilds] = useState<PdGuild[]>([]);
  const [pdPlayers, setPdPlayers] = useState<PdPlayerSummary[]>([]);
  const [guildsUnlocked, setGuildsUnlocked] = useState(false);
  const [guildDetailId, setGuildDetailId] = useState<string | null>(null);
  const [playerDetail, setPlayerDetail] = useState<{ id: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(fullscreen);
  const [showPlayers, setShowPlayers] = useState(true);
  const [showOffline, setShowOffline] = useState(false);
  const [showBases, setShowBases] = useState(true);
  const [showLandmarks, setShowLandmarks] = useState(false);
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  const [showBosses, setShowBosses] = useState(false);
  const [bosses, setBosses] = useState<Boss[]>([]);
  const [showOres, setShowOres] = useState(false);
  const [ores, setOres] = useState<OreData | null>(null);
  const [guildHint, setGuildHint] = useState(false);

  // Static landmark + boss sets (bundled), loaded once.
  useEffect(() => {
    fetch("/game-data/landmarks.json")
      .then((r) => (r.ok ? (r.json() as Promise<Landmark[]>) : []))
      .then((d) => setLandmarks(Array.isArray(d) ? d : []))
      .catch(() => setLandmarks([]));
    fetch("/game-data/bosses.json")
      .then((r) => (r.ok ? (r.json() as Promise<Boss[]>) : []))
      .then((d) => setBosses(Array.isArray(d) ? d : []))
      .catch(() => setBosses([]));
    fetch("/game-data/ores.json")
      .then((r) => (r.ok ? (r.json() as Promise<OreData>) : null))
      .then((d) => setOres(d && Array.isArray(d.spots) ? d : null))
      .catch(() => setOres(null));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setLive(await client.live(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // 公會據點是贊助者限定:非贊助者這裡回空陣列(detailed=false)。開關照樣顯示,
    // 只是標上星星表示要贊助才有。
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
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const baseCount = guilds.reduce((s, g) => s + g.bases.length, 0);
  const offlineCount = pdPlayers.filter(
    (p) => !p.online && p.worldX != null && p.worldY != null,
  ).length;
  const summary = live?.available
    ? t("在線玩家 {n} 人", { n: live.players.length }) + (baseCount > 0 ? ` · ${t("{n} 個公會據點", { n: baseCount })}` : "")
    : (live?.reason ?? t("伺服器未在運作,地圖無法顯示玩家。"));

  // 地圖面板本體:彈窗與全螢幕頁共用。全螢幕時鋪滿容器、去掉卡片外框與關閉鈕。
  const mapPanel = live?.available ? (
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
          {landmarks.length > 0 &&
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
          {bosses.length > 0 &&
            (guildsUnlocked ? (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5 ${showBosses ? "border-pal text-pal" : "opacity-60"}`}
                onClick={() => setShowBosses((v) => !v)}
              >
                <GiCrownedSkull className="size-4" /> {t("野外頭目")}
                <FiStar className="size-3.5 text-pal" />
              </button>
            ) : (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5 opacity-70`}
                title={t("此功能為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
                onClick={() => setGuildHint((v) => !v)}
              >
                <GiCrownedSkull className="size-4" /> {t("野外頭目")}
                <FiStar className="size-3.5 text-pal" />
              </button>
            ))}
          {ores && ores.spots.length > 0 &&
            (guildsUnlocked ? (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5 ${showOres ? "border-pal text-pal" : "opacity-60"}`}
                onClick={() => setShowOres((v) => !v)}
              >
                <GiMinerals className="size-4" /> {t("礦物")}
                <FiStar className="size-3.5 text-pal" />
              </button>
            ) : (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5 opacity-70`}
                title={t("此功能為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
                onClick={() => setGuildHint((v) => !v)}
              >
                <GiMinerals className="size-4" /> {t("礦物")}
                <FiStar className="size-3.5 text-pal" />
              </button>
            ))}
          {guildsUnlocked ? (
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5 ${showBases ? "border-pal text-pal" : "opacity-60"}`}
              onClick={() => setShowBases((v) => !v)}
            >
              <FiHome className="size-4" /> {t("公會據點")}
              <FiStar className="size-3.5 text-pal" />
            </button>
          ) : (
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5 opacity-70`}
              title={t("公會據點是贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
              onClick={() => setGuildHint((v) => !v)}
            >
              <FiHome className="size-4" /> {t("公會據點")}
              <FiStar className="size-3.5 text-pal" />
            </button>
          )}
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
            <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={() => setOpen(false)}>
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
          players={live.players}
          guilds={guilds}
          pdPlayers={pdPlayers}
          landmarks={landmarks}
          bosses={bosses}
          ores={ores}
          lang={lang}
          showPlayers={showPlayers}
          showOffline={showOffline}
          showBases={showBases}
          showLandmarks={showLandmarks}
          showBosses={showBosses}
          showOres={showOres}
          gameData={gameData}
          onGuildClick={setGuildDetailId}
          onPlayerClick={(id, label) => setPlayerDetail({ id, label })}
        />
      </div>
    </div>
  ) : null;

  const modals = (
    <>
      {guildDetailId && (
        <GuildDetailModal
          client={client}
          instanceId={instanceId}
          guildId={guildDetailId}
          onClose={() => setGuildDetailId(null)}
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
        <button
          className={`${btn} inline-flex items-center gap-1.5`}
          onClick={() => setOpen(true)}
          disabled={!live?.available}
        >
          <FiMap className="size-4" /> {t("開啟地圖")}
        </button>
      </div>

      {open && mapPanel && <Overlay onClose={() => setOpen(false)}>{mapPanel}</Overlay>}

      {modals}
    </div>
  );
}

/** 公會詳情彈窗(贊助者):成員名單 + 據點,取自 PalDefender /guild/{id}。 */
function GuildDetailModal({
  client,
  instanceId,
  guildId,
  onClose,
}: {
  client: AgentClient;
  instanceId: string;
  guildId: string;
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
          <button className={btnGhost} onClick={onClose}>
            <FiX className="inline size-4" /> {t("關閉")}
          </button>
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
                {detail.members.map((m) => (
                  <div key={m.playerUid} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                    <span className="min-w-0 truncate font-bold">{m.name || "—"}</span>
                    <span
                      className={`shrink-0 text-xs font-bold ${
                        m.status.toLowerCase() === "online" ? "text-grass" : "text-ink-muted"
                      }`}
                    >
                      {m.status.toLowerCase() === "online" ? t("在線") : t("離線")}
                    </span>
                  </div>
                ))}
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
  players,
  guilds,
  pdPlayers,
  landmarks,
  bosses,
  ores,
  lang,
  showPlayers,
  showOffline,
  showBases,
  showLandmarks,
  showBosses,
  showOres,
  gameData,
  onGuildClick,
  onPlayerClick,
}: {
  players: RestPlayer[];
  guilds: PdGuild[];
  /** PalDefender /players roster — matches live players to their guild, and
   * (when showOffline) provides offline players' last-saved positions. */
  pdPlayers: PdPlayerSummary[];
  landmarks: Landmark[];
  bosses: Boss[];
  ores: OreData | null;
  lang: "zh" | "zh-CN" | "en" | "ja";
  showPlayers: boolean;
  showOffline: boolean;
  showBases: boolean;
  showLandmarks: boolean;
  showBosses: boolean;
  showOres: boolean;
  gameData: GameData | null;
  onGuildClick?: (guildId: string) => void;
  /** Open the full player-detail view (same as the player list). */
  onPlayerClick?: (userId: string, name: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  // 礦物層獨立一組:~3.9k 個 canvas 圓點,只在資料/開關變化時重畫,
  // 不跟著 5 秒一次的即時資料重繪循環走。
  const oresGroupRef = useRef<L.LayerGroup | null>(null);
  const oresRendererRef = useRef<L.Canvas | null>(null);
  const onGuildClickRef = useRef(onGuildClick);
  onGuildClickRef.current = onGuildClick;
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
    L.imageOverlay(MAP_IMAGE, IMAGE_BOUNDS).addTo(map);
    map.setMaxBounds(IMAGE_BOUNDS.pad(0.3));
    // canvas 圓點畫在 overlay pane,天然壓在 divIcon 類 marker(markerPane)之下。
    oresRendererRef.current = L.canvas({ padding: 0.3 });
    oresGroupRef.current = L.layerGroup().addTo(map);
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
      map.setMinZoom(map.getBoundsZoom(IMAGE_BOUNDS) - 1);
      if (!fitted) {
        map.fitBounds(IMAGE_BOUNDS);
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
      oresGroupRef.current = null;
      oresRendererRef.current = null;
    };
  }, []);

  // 礦物層:每點一個 canvas 圓點,顏色分礦種,「大型」礦脈畫大顆;hover 顯示名稱。
  useEffect(() => {
    const group = oresGroupRef.current;
    const renderer = oresRendererRef.current;
    if (!group || !renderer) return;
    group.clearLayers();
    if (!showOres || !ores) return;
    for (const s of ores.spots) {
      const ty = ores.types[s.t];
      if (!ty) continue;
      const name = (lang === "zh-CN" ? ty.name.zhCN : ty.name[lang]) || ty.name.en;
      L.circleMarker([s.y, s.x], {
        renderer,
        radius: ty.big ? 6 : 3.5,
        color: "#ffffff",
        weight: 1,
        fillColor: ty.color,
        fillOpacity: 0.95,
      })
        .bindTooltip(`<div style="font-weight:800">${escapeHtml(name)}</div>`, {
          direction: "top",
          className: "pmap-detail",
        })
        .addTo(group);
    }
  }, [ores, showOres, lang]);

  useEffect(() => {
    const group = markersRef.current;
    if (!group) return;
    group.clearLayers();
    const SIZE = 40;

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
      g.bases.map((b) => ({ ...savToMap(b.worldX, b.worldY), guildId: g.id, guildName: g.name })),
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
            `<div style="font-weight:800">${escapeHtml((lang === "zh-CN" ? lm.name.zhCN : lm.name[lang]) || lm.name.en)}</div>` +
              `<div>${t(style.label)}${lm.lv ? ` · Lv.${lm.lv}` : ""}</div>`,
            { direction: "top", className: "pmap-detail" },
          )
          .addTo(group);
      }
    }

    // Field bosses (Alpha Pals): a distinct red-framed Pal portrait with a
    // crown badge + level — deliberately unlike the round guild-ringed player
    // avatars (no ping) and separate from the landmark layer.
    if (showBosses) {
      const BS = 36;
      for (const b of bosses) {
        const iconUrl = b.icon ? palIconUrl(b.icon) : null;
        const icon = L.divIcon({
          className: "pmap-boss-wrap",
          iconSize: [BS, BS],
          iconAnchor: [BS / 2, BS / 2],
          tooltipAnchor: [0, -BS / 2],
          html:
            `<span class="pmap-boss" style="width:${BS}px;height:${BS}px">` +
            (iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="" />` : "") +
            `<span class="pmap-boss-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M4 17l-2-10 5.5 4L12 4l4.5 7L22 7l-2 10z"/></svg></span>` +
            (b.lv ? `<span class="pmap-boss-lv">${b.lv}</span>` : "") +
            `</span>`,
        });
        L.marker([b.y, b.x], { icon, riseOnHover: true })
          .bindTooltip(
            `<div style="font-weight:800">${escapeHtml((lang === "zh-CN" ? b.name.zhCN : b.name[lang]) || b.name.en)}</div>` +
              `<div>${t("野外頭目")}${b.lv ? ` · Lv.${b.lv}` : ""}</div>`,
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
          const { x, y } = savToMap(b.worldX, b.worldY);
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
          marker.on("click", () => onGuildClickRef.current?.(g.id));
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
        const { x, y } = savToMap(pp.worldX, pp.worldY);
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
        const { x, y } = savToMap(p.location_x, p.location_y);
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
  }, [players, guilds, pdPlayers, landmarks, bosses, lang, showPlayers, showOffline, showBases, showLandmarks, showBosses, gameData]);

  return <div ref={containerRef} className="h-full w-full rounded-xl bg-card-soft" />;
}
