import { useCallback, useEffect, useRef, useState } from "react";
import { FiRefreshCw, FiMap, FiX, FiHome, FiUsers, FiStar } from "react-icons/fi";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  savToMap,
  type LiveStatus,
  type RestPlayer,
  type PdGuild,
  type PdGuildDetail,
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
const MAP_IMAGE = "/palpagos-world-map.webp";

/**
 * MAP_IMAGE is framed to the in-game map coordinate square: [-1000, 1000] on
 * both axes (the same system savToMap outputs and the REST/in-game coordinates
 * use). Verified empirically — two known-coordinate terrain points land within
 * ~0.0005 of the ±1000 prediction. CRS.Simple uses [lat,lng] = [mapY (north),
 * mapX (east)], so the image spans [[south, west], [north, east]]:
 */
const IMAGE_BOUNDS = L.latLngBounds([-1000, -1000], [1000, 1000]);

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

export function MapTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const gameData = useGameData();
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [guilds, setGuilds] = useState<PdGuild[]>([]);
  const [guildsUnlocked, setGuildsUnlocked] = useState(false);
  const [guildDetailId, setGuildDetailId] = useState<string | null>(null);
  const [playerDetail, setPlayerDetail] = useState<{ id: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [showPlayers, setShowPlayers] = useState(true);
  const [showBases, setShowBases] = useState(true);
  const [guildHint, setGuildHint] = useState(false);

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
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const baseCount = guilds.reduce((s, g) => s + g.bases.length, 0);
  const summary = live?.available
    ? t("在線玩家 {n} 人", { n: live.players.length }) + (baseCount > 0 ? ` · ${t("{n} 個公會據點", { n: baseCount })}` : "")
    : (live?.reason ?? t("伺服器未在運作,地圖無法顯示玩家。"));

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

      {open && live?.available && (
        <Overlay onClose={() => setOpen(false)}>
          <div
            className="flex h-[min(88vh,92vw)] w-[min(88vh,92vw)] max-w-full flex-col gap-2 rounded-(--radius-cute) border-2 border-line bg-card p-3 shadow-(--shadow-cute)"
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
                {guildsUnlocked ? (
                  <button
                    className={`${btnGhost} inline-flex items-center gap-1.5 ${showBases ? "border-pal text-pal" : "opacity-60"}`}
                    onClick={() => setShowBases((v) => !v)}
                  >
                    <FiHome className="size-4" /> {t("公會據點")}
                  </button>
                ) : (
                  <button
                    className={`${btnGhost} inline-flex items-center gap-1.5 opacity-70`}
                    title={t("公會據點是贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
                    onClick={() => setGuildHint((v) => !v)}
                  >
                    <FiHome className="size-4" /> {t("公會據點")}
                    <FiStar className="size-3.5 text-sun" />
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button className={btnGhost} onClick={refresh} aria-label={t("重新整理")}>
                  <FiRefreshCw className="size-4" />
                </button>
                <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={() => setOpen(false)}>
                  <FiX className="size-4" /> {t("關閉")}
                </button>
              </div>
            </div>
            {guildHint && !guildsUnlocked && (
              <p className="rounded-xl bg-sun/15 px-3 py-2 text-[13px] font-bold text-sun">
                {t("公會據點是贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-hidden rounded-xl">
              <PlayerMap
                players={live.players}
                guilds={guilds}
                showPlayers={showPlayers}
                showBases={showBases}
                gameData={gameData}
                onGuildClick={setGuildDetailId}
                onPlayerClick={(id, label) => setPlayerDetail({ id, label })}
              />
            </div>
          </div>
        </Overlay>
      )}

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
                  <div key={m.playerUid} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span className="truncate font-bold">{m.name || "—"}</span>
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
                    <div key={c.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="font-bold">
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
  showPlayers,
  showBases,
  gameData,
  onGuildClick,
  onPlayerClick,
}: {
  players: RestPlayer[];
  guilds: PdGuild[];
  showPlayers: boolean;
  showBases: boolean;
  gameData: GameData | null;
  onGuildClick?: (guildId: string) => void;
  /** Open the full player-detail view (same as the player list). */
  onPlayerClick?: (userId: string, name: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
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
      maxZoom: 3,
    });
    map.setView(IMAGE_BOUNDS.getCenter(), -2); // provisional view; applySize refits properly
    el.style.background = "transparent"; // let the card bg show past the image instead of Leaflet's grey
    L.imageOverlay(MAP_IMAGE, IMAGE_BOUNDS).addTo(map);
    map.setMaxBounds(IMAGE_BOUNDS.pad(0.3));
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
    };
  }, []);

  useEffect(() => {
    const group = markersRef.current;
    if (!group) return;
    group.clearLayers();
    const SIZE = 40;

    // Map every guild member (PlayerUID) to its guild, so a player's avatar can
    // be ringed and labelled with their guild colour/name.
    const guildByMember = new Map<string, PdGuild>();
    for (const g of guilds) for (const uid of g.members) guildByMember.set(uid, g);
    const guildOf = (p: RestPlayer) => guildByMember.get(p.playerId) ?? guildByMember.get(p.userId);

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

    // Guild bases first (under players). world_pos → savToMap, same frame.
    // The whole guild feature is sponsor-only, so if we have any guild data the
    // viewer is a sponsor — bases are always coloured, named, and clickable.
    if (showBases) {
      for (const g of guilds) {
        const color = guildColor(g.id);
        for (const b of g.bases) {
          const { x, y } = savToMap(b.worldX, b.worldY);
          const icon = L.divIcon({
            className: "pmap-base-wrap",
            iconSize: [26, 26],
            iconAnchor: [13, 13],
            tooltipAnchor: [0, -13],
            html:
              `<span class="pmap-base" style="background:${color}">` +
              `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>` +
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

    if (showPlayers)
      for (const p of players) {
        const { x, y } = savToMap(p.location_x, p.location_y);
        const iconUrl = avatarIconUrl(p.userId, gameData);
        const guild = guildOf(p);
        const ring = guild ? guildColor(guild.id) : "#ffffff";
        const raidingGuild = enemyBaseNear(x, y, guild?.id);
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
  }, [players, guilds, showPlayers, showBases, gameData]);

  return <div ref={containerRef} className="h-full w-full rounded-xl bg-card-soft" />;
}
