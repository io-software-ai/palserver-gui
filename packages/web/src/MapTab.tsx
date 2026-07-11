import { useCallback, useEffect, useRef, useState } from "react";
import { FiRefreshCw } from "react-icons/fi";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { savToMap, type LiveStatus, type RestPlayer, type PdGuild } from "@palserver/shared";
import type { AgentClient } from "./api";
import { useGameData, palIconUrl, type GameData } from "./gameData";
import { t, useI18n } from "./i18n";
import { btnGhost, card, errorCls } from "./ui";

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
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLive(await client.live(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // 公會據點來自 PalDefender REST(沒開就沒有,靜默略過,不擋地圖)。
    client
      .guilds(instanceId)
      .then((g) => setGuilds(g.available ? g.guilds : []))
      .catch(() => setGuilds([]));
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!live) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;
  if (!live.available) {
    return (
      <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-12 text-center text-ink-muted">
        <p className="font-bold">{t("無法連線到伺服器的 REST API")}</p>
        <p className="mt-1 text-[13px]">{live.reason}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className={errorCls}>{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-ink-muted">
          {t("在線玩家 {n} 人", { n: live.players.length })}
          {guilds.length > 0 && ` · ${t("{n} 個公會據點", { n: guilds.reduce((s, g) => s + g.bases.length, 0) })}`}
        </p>
        <button className={btnGhost} onClick={refresh} aria-label={t("重新整理")}>
          <FiRefreshCw className="size-4" />
        </button>
      </div>

      <div className={`${card} overflow-hidden p-2`}>
        <PlayerMap players={live.players} guilds={guilds} gameData={gameData} />
      </div>

      <p className="text-[13px] text-ink-muted">
        {t("玩家位置即時顯示在官方世界地圖上,座標來自伺服器 REST API。滑鼠滾輪縮放、拖曳平移,點玩家看詳情。")}
      </p>
    </div>
  );
}

/** Leaflet CRS.Simple map + avatar markers for players and base markers for
 * guilds (both from savToMap, so they share the players' coordinate frame). */
function PlayerMap({
  players,
  guilds,
  gameData,
}: {
  players: RestPlayer[];
  guilds: PdGuild[];
  gameData: GameData | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);

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

    // Guild bases first (under players). world_pos → savToMap, same frame.
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
        L.marker([y, x], { icon })
          .bindTooltip(
            `<div style="font-weight:800">${escapeHtml(g.name || "—")}</div>` +
              `<div>${t("公會據點")} · Lv.${g.level} · ${t("{n} 名成員", { n: g.memberCount })}</div>`,
            { direction: "top", className: "pmap-detail" },
          )
          .addTo(group);
      }
    }

    for (const p of players) {
      const { x, y } = savToMap(p.location_x, p.location_y);
      const iconUrl = avatarIconUrl(p.userId, gameData);
      const guild = guildOf(p);
      const ring = guild ? guildColor(guild.id) : "#ffffff";
      // A round Pal-avatar pin (same random Pal as the player list), built as a
      // div-icon so it can hold an <img>. The border is the guild colour when
      // the player is in one. Details show on hover, not always.
      const icon = L.divIcon({
        className: "pmap-avatar-wrap",
        iconSize: [SIZE, SIZE],
        iconAnchor: [SIZE / 2, SIZE / 2],
        tooltipAnchor: [0, -SIZE / 2],
        html: `<span class="pmap-avatar" style="width:${SIZE}px;height:${SIZE}px;border-color:${ring}">${
          iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="" />` : ""
        }</span>`,
      });
      const marker = L.marker([y, x], { icon, riseOnHover: true });
      marker.bindTooltip(
        `<div style="font-weight:800">${escapeHtml(p.name || "—")}</div>` +
          (guild ? `<div style="color:${ring}">${escapeHtml(guild.name)}</div>` : "") +
          `<div>${t("座標")} ${Math.round(x)}, ${Math.round(y)} · Lv.${p.level}</div>`,
        { direction: "top", className: "pmap-detail" },
      );
      group.addLayer(marker);
    }
  }, [players, guilds, gameData]);

  return <div ref={containerRef} className="aspect-square w-full rounded-xl bg-card-soft" />;
}
