'use client';

import { useEffect, useRef } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getMapDict, type MapLang } from './i18n';
import type { MapSnapshotV1, MapWorld, OreData, StaticLandmark } from './types';
import { badgeIcon, initialHtml, letterColor, nameLabelHtml } from './markerIcon';

// 底圖與座標邊界:原樣抄自 packages/web/src/MapTab.tsx:36-52(GUI 本體的即時地圖用
// 同一組常數)。快照裡的 x/y 已經是 agent 端算好的「地圖座標」,不是存檔原始世界座標,
// 所以這裡不需要 savToMap/savToWorldTreeMap 轉換,直接當 [y, x] 丟給 Leaflet 即可。
const MAP_IMAGE = '/map-assets/palworld-full-map.jpg';
const IMAGE_BOUNDS = L.latLngBounds([-2125.3, -1922.44], [1031.13, 1233.99]);
const TREE_MAP_IMAGE = '/map-assets/worldtree-map.webp';
const TREE_IMAGE_BOUNDS = L.latLngBounds([-1000, -1000], [1000, 1000]);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** 每個公會名一個穩定色(同 packages/web/src/MapTab.tsx 的 guildColor)。 */
function guildColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 70% 52%)`;
}

const LANDMARK_ICON: Record<string, { icon: string; size: number }> = {
  'Fast Travel': { icon: '/map-assets/landmark-icons/fasttravel.png', size: 26 },
  Tower: { icon: '/map-assets/landmark-icons/tower.png', size: 30 },
};

export default function LeafletMap({
  world,
  snapshot,
  landmarks,
  treeLandmarks,
  ores,
  treeOres,
  showPlayers,
  showOffline,
  showBases,
  showLandmarks,
  showOres,
  showNames,
  showGuildNames,
  lang,
}: {
  world: MapWorld;
  snapshot: MapSnapshotV1;
  landmarks: StaticLandmark[];
  treeLandmarks: StaticLandmark[];
  ores: OreData | null;
  treeOres: OreData | null;
  showPlayers: boolean;
  showOffline: boolean;
  showBases: boolean;
  showLandmarks: boolean;
  showOres: boolean;
  showNames: boolean;
  showGuildNames: boolean;
  lang: MapLang;
}) {
  const d = getMapDict(lang);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const boundsRef = useRef<L.LatLngBounds>(IMAGE_BOUNDS);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const oresGroupRef = useRef<L.LayerGroup | null>(null);
  const oresRendererRef = useRef<L.Canvas | null>(null);

  // 建圖(只跑一次):CRS.Simple + 空的 marker layer group,底圖交給下面的 world effect。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el, {
      crs: L.CRS.Simple,
      attributionControl: false,
      zoomSnap: 0.25,
      maxZoom: 4,
    });
    map.setView(IMAGE_BOUNDS.getCenter(), -2);
    // 礦物層獨立一組 canvas 渲染器,~3.9k 個點扛不住 DOM marker(同 GUI MapTab 的作法)。
    oresRendererRef.current = L.canvas({ padding: 0.3 });
    oresGroupRef.current = L.layerGroup().addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

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
      oresGroupRef.current = null;
      oresRendererRef.current = null;
    };
  }, []);

  // 底圖切換(主世界 / 世界樹):換 overlay 與邊界,重新 fit。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = world === 'tree' ? TREE_IMAGE_BOUNDS : IMAGE_BOUNDS;
    boundsRef.current = bounds;
    const overlay = L.imageOverlay(world === 'tree' ? TREE_MAP_IMAGE : MAP_IMAGE, bounds).addTo(map);
    overlay.bringToBack();
    map.setMaxBounds(bounds.pad(0.3));
    if (map.getSize().y > 0) {
      map.setMinZoom(map.getBoundsZoom(bounds) - 1);
      map.fitBounds(bounds);
    }
    return () => {
      map.removeLayer(overlay);
    };
  }, [world]);

  // 礦物層:每點一個 canvas 圓點,顏色分礦種,「大型」礦脈畫大顆;白色描邊呼應徽章體系
  // 的描邊語言。抄自 packages/web/src/MapTab.tsx 的同名 effect。預設關(3.9k 點,手機效能)。
  useEffect(() => {
    const group = oresGroupRef.current;
    const renderer = oresRendererRef.current;
    if (!group || !renderer) return;
    group.clearLayers();
    const data = world === 'tree' ? treeOres : ores;
    if (!showOres || !data) return;
    for (const s of data.spots) {
      const ty = data.types[s.t];
      if (!ty) continue;
      const name = ty.name[lang] || ty.name.en;
      L.circleMarker([s.y, s.x], {
        renderer,
        radius: ty.big ? 6 : 3.5,
        color: '#ffffff',
        weight: 1,
        fillColor: ty.color,
        fillOpacity: 0.95,
      })
        .bindTooltip(`<div style="font-weight:800">${escapeHtml(name)}</div>`, {
          direction: 'top',
          className: 'pmap2-tooltip',
        })
        .addTo(group);
    }
  }, [ores, treeOres, showOres, lang, world]);

  // 畫標記:玩家(在線/離線)、據點、靜態地標。快照數量小(<100),DOM marker 就夠。
  useEffect(() => {
    const group = markersRef.current;
    if (!group) return;
    group.clearLayers();

    const inWorld = (m: string | undefined) => (m === 'tree') === (world === 'tree');
    const curLandmarks = world === 'tree' ? treeLandmarks : landmarks;

    if (showLandmarks) {
      for (const lm of curLandmarks) {
        const style = LANDMARK_ICON[lm.type];
        if (!style) continue; // 只顯示 Fast Travel / Tower,其餘(如 Dungeon)這頁不畫
        const icon = badgeIcon({
          size: style.size,
          ring: 'var(--pal)',
          contentHtml: `<img src="${style.icon}" alt="" />`,
          wrapClass: 'pmap2-badge-wrap',
          extraClass: 'pmap2-badge--thick',
        });
        const name = lm.name[lang] || lm.name.en || '';
        const typeLabel = lm.type === 'Tower' ? d.tower : d.fastTravel;
        L.marker([lm.y, lm.x], { icon })
          .bindTooltip(
            `<div style="font-weight:800">${escapeHtml(name)}</div>` +
              `<div>${escapeHtml(typeLabel)}${lm.lv ? ` · Lv.${lm.lv}` : ''}</div>`,
            { direction: 'top', className: 'pmap2-tooltip' },
          )
          .addTo(group);
      }
    }

    if (showBases) {
      for (const b of snapshot.bases ?? []) {
        if (!inWorld(b.m)) continue;
        const color = b.g ? guildColor(b.g) : '#9aa3b5';
        const icon = badgeIcon({
          size: 30,
          ring: color,
          contentHtml: `<img src="/map-assets/landmark-icons/palbox.webp" alt="" />`,
          wrapClass: 'pmap2-badge-wrap',
          extraClass: 'pmap2-badge--thick',
        });
        const marker = L.marker([b.y, b.x], { icon });
        if (showGuildNames && b.g) {
          marker.bindTooltip(`<div style="font-weight:800">${escapeHtml(b.g)}</div><div>${escapeHtml(d.bases)}</div>`, {
            direction: 'top',
            className: 'pmap2-tooltip',
          });
        } else {
          marker.bindTooltip(`<div>${escapeHtml(d.bases)}</div>`, { direction: 'top', className: 'pmap2-tooltip' });
        }
        marker.addTo(group);
      }
    }

    if (showOffline) {
      for (const p of snapshot.offline ?? []) {
        if (!inWorld(p.m)) continue;
        addPlayerDot(group, p, { offline: true, showNames, lang, d });
      }
    }

    if (showPlayers) {
      for (const p of snapshot.players ?? []) {
        if (!inWorld(p.m)) continue;
        addPlayerDot(group, p, { offline: false, showNames, lang, d });
      }
    }
  }, [
    world,
    snapshot,
    landmarks,
    treeLandmarks,
    showPlayers,
    showOffline,
    showBases,
    showLandmarks,
    showNames,
    showGuildNames,
    lang,
    d,
  ]);

  return <div ref={containerRef} className="map2-canvas" />;
}

// 玩家徽章:圓形、雜湊色底 + 名字首字母(見 markerIcon.ts 的說明 —— viewer 沒有真人頭像
// 可用)。線上白框,離線用灰框 + 變暗,對齊 GUI 的 .pmap-avatar / .pmap-avatar.pmap-offline。
const PLAYER_SIZE = 32;

function addPlayerDot(
  group: L.LayerGroup,
  p: { n: string; lv: number; x: number; y: number },
  opts: { offline: boolean; showNames: boolean; lang: MapLang; d: ReturnType<typeof getMapDict> },
) {
  const { offline, showNames, d } = opts;
  const name = p.n || '—';
  const icon = badgeIcon({
    size: PLAYER_SIZE,
    ring: offline ? '#8a94a3' : '#ffffff',
    background: letterColor(name),
    contentHtml: initialHtml(name, PLAYER_SIZE),
    wrapClass: 'pmap2-badge-wrap',
    extraClass: offline ? 'pmap2-badge-offline' : '',
    labelHtml: showNames ? nameLabelHtml(escapeHtml(name), PLAYER_SIZE, { offline }) : '',
  });
  const marker = L.marker([p.y, p.x], { icon, riseOnHover: true });
  marker.bindTooltip(
    `<div style="font-weight:800">${escapeHtml(name)}</div>` +
      `<div>${d.lv}${p.lv}${offline ? ` · ${escapeHtml(d.lastSeenAt)}` : ''}</div>`,
    { direction: 'top', className: 'pmap2-tooltip' },
  );
  marker.addTo(group);
}
