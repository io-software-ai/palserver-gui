// 公開地圖快照的資料形狀(agent 每 60 秒推到 Cloudflare Worker,這裡是唯讀 viewer)。
// 座標系:x/y 已經是「地圖座標」(agent 端算好的,不是存檔原始世界座標),m 決定要對到
// 哪張底圖 —— "world" 對主世界底圖,"tree" 對世界樹底圖。兩張底圖各自的邊界常數
// 抄自 packages/web/src/MapTab.tsx(IMAGE_BOUNDS / TREE_IMAGE_BOUNDS)。

export type SnapshotWorld = 'world' | 'tree';

export interface SnapshotEntity {
  /** 顯示名 */
  n: string;
  lv: number;
  x: number;
  y: number;
  /** 缺省視為 "world"(主世界)。 */
  m?: SnapshotWorld;
}

export interface SnapshotBase {
  x: number;
  y: number;
  m?: SnapshotWorld;
  /** 公會名,可能省略。 */
  g?: string;
}

export interface MapSnapshotV1 {
  v: 1;
  name: string;
  generatedAt: number;
  onlineCount: number;
  maxPlayers?: number;
  show: {
    players?: boolean;
    names?: boolean;
    offline?: boolean;
    bases?: boolean;
    guildNames?: boolean;
  };
  /** 關掉的圖層,這個 key 可能整個不存在。 */
  players?: SnapshotEntity[];
  offline?: SnapshotEntity[];
  bases?: SnapshotBase[];
}

export interface SnapshotApiResponse {
  updatedAt: number;
  snapshot: MapSnapshotV1 | null;
}

/** 靜態地標(Fast Travel / Tower):抄自 packages/web/src/MapTab.tsx 的 Landmark 形狀。 */
export interface StaticLandmark {
  type: string;
  name: { en: string; zh: string; 'zh-CN'?: string; zhCN?: string; ja: string };
  x: number;
  y: number;
  lv?: number;
}

export type MapWorld = 'main' | 'tree';

/** 礦物靜態圖層:抄自 packages/web/src/MapTab.tsx 的 OreData 形狀,資料來源
 * game-data/ores.json / worldtree-ores.json(scripts/copy-map-assets.mjs 同步)。 */
export interface OreType {
  name: { en: string; zh: string; 'zh-CN'?: string; zhCN?: string; ja: string };
  icon: string;
  color: string;
  big?: boolean;
}

export interface OreData {
  types: Record<string, OreType>;
  spots: { t: string; x: number; y: number }[];
}
