import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bossRespawnInfo,
  bossStateMapCoord,
  isBossStateStale,
  matchReportedBoss,
  assignReportedBosses,
  DEFAULT_BOSS_RESPAWN_SECONDS,
  BOSS_MATCH_MAP_RADIUS,
  type BossStateEntry,
} from "./index.js";
import { savToMap, savToWorldTreeMap, isWorldTreeCoord } from "./index.js";

function entry(patch: Partial<BossStateEntry>): BossStateEntry {
  return {
    name: "81_1_grass_FBOSS_4",
    alive: false,
    diedAt: -1,
    respawnedAt: -1,
    respawnInterval: -1,
    x: 0,
    y: 0,
    z: 0,
    ...patch,
  };
}

test("bossRespawnInfo:未配對 / alive=null → unknown,無倒數", () => {
  assert.equal(bossRespawnInfo(null, 1000).status, "unknown");
  assert.equal(bossRespawnInfo(entry({ alive: null }), 1000).status, "unknown");
  assert.equal(bossRespawnInfo(null, 1000).secondsLeft, null);
});

test("bossRespawnInfo:alive=true → alive,無倒數", () => {
  const r = bossRespawnInfo(entry({ alive: true }), 1000);
  assert.equal(r.status, "alive");
  assert.equal(r.secondsLeft, null);
});

test("bossRespawnInfo:已擊殺 + 有 diedAt,無實測 → 用預設 3600s 倒數", () => {
  const died = 1000;
  const now = died + 600; // 死後 10 分鐘
  const r = bossRespawnInfo(entry({ alive: false, diedAt: died }), now);
  assert.equal(r.status, "dead");
  assert.equal(r.measured, false);
  assert.equal(r.diedAt, died);
  assert.equal(r.respawnAt, died + DEFAULT_BOSS_RESPAWN_SECONDS);
  assert.equal(r.secondsLeft, DEFAULT_BOSS_RESPAWN_SECONDS - 600);
});

test("bossRespawnInfo:有實測 respawnInterval → 優先採用,measured=true", () => {
  const died = 5000;
  const measured = 1800; // 實測 30 分鐘重生
  const r = bossRespawnInfo(entry({ alive: false, diedAt: died, respawnInterval: measured }), died + 100);
  assert.equal(r.measured, true);
  assert.equal(r.respawnAt, died + measured);
  assert.equal(r.secondsLeft, measured - 100);
});

test("bossRespawnInfo:已擊殺但沒觀測到擊殺時間(diedAt<=0)→ dead 但無倒數", () => {
  const r = bossRespawnInfo(entry({ alive: false, diedAt: -1 }), 1000);
  assert.equal(r.status, "dead");
  assert.equal(r.secondsLeft, null);
  assert.equal(r.respawnAt, null);
});

test("bossRespawnInfo:倒數過期為負值(早該重生但模組尚未觀測到)", () => {
  const died = 1000;
  const r = bossRespawnInfo(entry({ alive: false, diedAt: died }), died + DEFAULT_BOSS_RESPAWN_SECONDS + 120);
  assert.ok(r.secondsLeft !== null && r.secondsLeft < 0);
});

test("matchReportedBoss:半徑內取最近,半徑外回 null", () => {
  // 造一個地圖座標 (0,0) 的 spawner:savToMap 反解 → savX=-123888, savY=158000
  const atOrigin = entry({ x: -123888, y: 158000 });
  const m = bossStateMapCoord(atOrigin);
  assert.ok(Math.abs(m.x) < 1e-6 && Math.abs(m.y) < 1e-6, "應轉到地圖原點");

  assert.equal(matchReportedBoss(0, 0, [atOrigin]), atOrigin);
  // 距原點很遠(500,500)> 預設半徑 60 → 找不到
  assert.equal(matchReportedBoss(500, 500, [atOrigin]), null);
});

test("matchReportedBoss:多筆時取最近的那筆", () => {
  // near:世界座標對應地圖約 (0,0);far:明顯偏移
  const near = entry({ name: "near", x: -123888, y: 158000 });
  const far = entry({ name: "far", x: -123888 + 459 * 40, y: 158000 }); // 地圖 y 偏 40
  const hit = matchReportedBoss(0, 0, [far, near], BOSS_MATCH_MAP_RADIUS);
  assert.equal(hit?.name, "near");
});

test("isBossStateStale:新鮮不過時,超過門檻過時", () => {
  const now = 100000;
  assert.equal(isBossStateStale({ generatedAt: now - 10 }, now), false);
  assert.equal(isBossStateStale({ generatedAt: now - 120 }, now), true);
  assert.equal(isBossStateStale(null, now), false);
});

test("bossStateMapCoord 與 savToMap 對主世界座標一致", () => {
  const e = entry({ x: -1000, y: 200000 });
  assert.deepEqual(bossStateMapCoord(e), savToMap(-1000, 200000));
});

test("bossStateMapCoord 對世界樹座標走 savToWorldTreeMap 分支", () => {
  // 世界樹頭目 spawner(savX > 350000,取自 worldtree.test.ts 的 Celesdir Noct)
  const treeEntry = entry({ x: 520440, y: -727175 });
  assert.equal(isWorldTreeCoord(520440), true);
  assert.deepEqual(bossStateMapCoord(treeEntry), savToWorldTreeMap(520440, -727175));
});

test("matchReportedBoss:世界樹 spawner 對到自身的世界樹地圖座標", () => {
  const treeSpawner = entry({ name: "tree", x: 520440, y: -727175 });
  const m = bossStateMapCoord(treeSpawner);
  assert.equal(matchReportedBoss(m.x, m.y, [treeSpawner]), treeSpawner);
});

test("assignReportedBosses:一對一,鄰近頭目不共用 spawner(未載入者維持未知)", () => {
  // Lyleen / Lyleen Noct 型:兩頭目僅 4.5 地圖單位,只有一隻的 spawner 被回報。
  const A = { x: 100, y: 100 };
  const B = { x: 104.5, y: 100 };
  const spawnerAtA = entry({ name: "sp", alive: true, x: -77988, y: 203900 }); // 地圖 (100,100)
  const m = bossStateMapCoord(spawnerAtA);
  assert.ok(Math.abs(m.x - 100) < 1e-6 && Math.abs(m.y - 100) < 1e-6, "spawner 應落在 (100,100)");
  const assigned = assignReportedBosses([A, B], [spawnerAtA]);
  assert.equal(assigned.get(A), spawnerAtA, "最近的 A 拿到 spawner");
  assert.equal(assigned.has(B), false, "B 未配到 → 狀態未知(不被鄰居冒充)");
});

test("assignReportedBosses:兩 spawner 兩頭目各自最近配對(不交叉)", () => {
  const A = { x: 0, y: 0 };
  const B = { x: 500, y: 0 };
  const spA = entry({ name: "a", x: -123888, y: 158000 }); // 地圖 (0,0)
  const spB = entry({ name: "b", x: -123888, y: 158000 + 500 * 459 }); // 地圖 (500,0)
  const assigned = assignReportedBosses([A, B], [spB, spA]); // 故意亂序
  assert.equal(assigned.get(A), spA);
  assert.equal(assigned.get(B), spB);
});

test("依世界分池(isWorldTreeCoord)後,主世界/世界樹 spawner 各歸各池——防 ±1000 撞號誤配", () => {
  // 兩套地圖座標都是 ±1000,純函式本身不分世界,呼叫端(web)必須先依世界分池。
  const treeSpawner = entry({ name: "tree", x: 520440, y: -727175 });
  const mainSpawner = entry({ name: "main", x: -1000, y: 200000 });
  const pool = [treeSpawner, mainSpawner];
  const mainReported = pool.filter((e) => !isWorldTreeCoord(e.x));
  const treeReported = pool.filter((e) => isWorldTreeCoord(e.x));
  assert.deepEqual(mainReported.map((e) => e.name), ["main"]);
  assert.deepEqual(treeReported.map((e) => e.name), ["tree"]);
});
