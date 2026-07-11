import { useCallback, useEffect, useRef, useState } from "react";
import { FiRefreshCw } from "react-icons/fi";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { savToMap, type LiveStatus, type RestPlayer } from "@palserver/shared";
import type { AgentClient } from "./api";
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
 * Map-coordinate corners of MAP_IMAGE, from palworld.wiki.gg/wiki/Maps
 * (DataMaps): topLeft [x -1954.074, y 1245.725], bottomRight [x 1200.261,
 * y -1908.610]. CRS.Simple uses [lat,lng] = [mapY (north), mapX (east)], so the
 * image spans [[south, west], [north, east]]:
 */
const IMAGE_BOUNDS = L.latLngBounds(
  [-1908.61002179, -1954.07407407],
  [1245.7254902, 1200.26143791],
);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function MapTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLive(await client.live(instanceId));
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
        <p className="text-[13px] font-bold text-ink-muted">{t("在線玩家 {n} 人", { n: live.players.length })}</p>
        <button className={btnGhost} onClick={refresh} aria-label={t("重新整理")}>
          <FiRefreshCw className="size-4" />
        </button>
      </div>

      <div className={`${card} overflow-hidden p-2`}>
        <PlayerMap players={live.players} />
      </div>

      <p className="text-[13px] text-ink-muted">
        {t("玩家位置即時顯示在官方世界地圖上,座標來自伺服器 REST API。滑鼠滾輪縮放、拖曳平移,點玩家看詳情。")}
      </p>
    </div>
  );
}

/** Leaflet CRS.Simple map + one circle marker per online player. */
function PlayerMap({ players }: { players: RestPlayer[] }) {
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
    const pal =
      getComputedStyle(document.documentElement).getPropertyValue("--color-pal").trim() || "#7c5cff";
    for (const p of players) {
      const { x, y } = savToMap(p.location_x, p.location_y);
      const marker = L.circleMarker([y, x], {
        radius: 7,
        weight: 3,
        color: "#ffffff",
        fillColor: pal,
        fillOpacity: 1,
      });
      marker.bindTooltip(escapeHtml(p.name || "—"), {
        permanent: true,
        direction: "top",
        offset: L.point(0, -6),
        className: "pmap-label",
      });
      marker.bindPopup(
        `<div style="font-weight:800">${escapeHtml(p.name || "—")}</div>` +
          `<div>${t("座標")} ${Math.round(x)}, ${Math.round(y)} · Lv.${p.level}</div>`,
      );
      group.addLayer(marker);
    }
  }, [players]);

  return <div ref={containerRef} className="aspect-square w-full rounded-xl bg-card-soft" />;
}
