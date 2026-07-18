import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractPaldeck, getBreedingSnapshot } from "./save-tools.js";
import type { DriverContext } from "./driver.js";

// 形狀出處:KrisCris/Palworld-Pal-Editor player_entity.py:383-408(palworld-save-tools JSON 慣例)。
// 簡單型別的 Map 條目 key/value 是裸值;防禦性也要接受 {value} 包裝。

test("extractPaldeck:PaldeckUnlockFlag(true)與 PalCaptureCount(>0)取聯集", () => {
  const sd = {
    RecordData: {
      value: {
        PaldeckUnlockFlag: {
          value: [
            { key: "SheepBall", value: true },
            { key: "PinkCat", value: false }, // 未登錄不算
          ],
        },
        PalCaptureCount: {
          value: [
            { key: "Sheepball", value: 3 }, // 大小寫與 unlock 不同 → 兩筆都保留,消費端不分大小寫
            { key: "Penguin", value: 1 },
            { key: "Bastet", value: 0 }, // 次數 0 不算
          ],
        },
      },
    },
  };
  const deck = extractPaldeck(sd)!;
  assert.deepEqual([...deck].sort(), ["Penguin", "SheepBall", "Sheepball"]);
});

test("extractPaldeck:接受 {value} 包裝的 key/value", () => {
  const sd = {
    RecordData: {
      value: {
        PalCaptureCount: {
          value: [{ key: { value: "Anubis" }, value: { value: 2 } }],
        },
      },
    },
  };
  assert.deepEqual(extractPaldeck(sd), ["Anubis"]);
});

test("extractPaldeck:沒有 RecordData 或兩張 Map 都缺 → null(舊檔/解析不到)", () => {
  assert.equal(extractPaldeck(undefined), null);
  assert.equal(extractPaldeck({}), null);
  assert.equal(extractPaldeck({ RecordData: { value: {} } }), null);
});

test("extractPaldeck:只有 unlock flag 也能運作,且去重", () => {
  const sd = {
    RecordData: {
      value: {
        PaldeckUnlockFlag: {
          value: [
            { key: "Kitsunebi", value: true },
            { key: "Kitsunebi", value: true },
          ],
        },
      },
    },
  };
  assert.deepEqual(extractPaldeck(sd), ["Kitsunebi"]);
});

test("getBreedingSnapshot:只攤平帕魯並保留主人來源", () => {
  const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "palserver-breeding-test-"));
  try {
    fs.writeFileSync(
      path.join(instanceDir, "save-players.json"),
      JSON.stringify({
        world: {
          worldGuid: "world",
          generatedAt: "2026-07-18T00:00:00Z",
          levelSavMtime: "2026-07-18T00:00:00Z",
          players: [{
            uid: "owner-1", name: "Alice", pals: [{ instanceId: "pal-1", characterId: "SheepBall" }],
          }],
        },
      }),
    );
    const result = getBreedingSnapshot({ instanceDir } as DriverContext, "world");
    assert.equal(result.generatedAt, "2026-07-18T00:00:00Z");
    assert.deepEqual(result.pals, [{
      instanceId: "pal-1", characterId: "SheepBall", ownerUid: "owner-1", ownerName: "Alice",
    }]);
  } finally {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});

test("computeScanStats:公會深度欄位(成員等級對聯/活躍/駐守/倉庫/研究/資產)", async () => {
  const { computeScanStats } = await import("./save-tools.js");
  const { guildScore } = await import("@palserver/shared");
  const pal = (level: number, iv: number) => ({
    instanceId: "i1", characterId: "SheepBall", level, gender: null, rank: 1,
    isLucky: false, isBoss: false, talentHp: iv, talentShot: 0, talentDefense: 0,
    passives: ["Rare"], location: "palbox" as const,
  });
  const stats = computeScanStats({
    worldGuid: "w", generatedAt: "2026-07-16T00:00:00Z", levelSavMtime: "2026-07-16T00:00:00Z",
    players: [
      { uid: "AA-bb", name: "P1", level: 40, exp: 1, guildName: "G", lastOnlineDaysAgo: 0, palCount: 10,
        pals: [pal(30, 90)], inventory: { money: 1000, common: [], essential: [], weapons: [], armor: [], food: [] } },
      { uid: "cc", name: "P2", level: 20, exp: 1, guildName: "G", lastOnlineDaysAgo: 30, palCount: 5,
        pals: [], inventory: null },
    ],
    guilds: [{
      id: "g1", name: "G", adminUid: null, baseCampLevel: 12,
      members: [
        { uid: "aabb", name: "P1", lastOnlineDaysAgo: 0 },  // uid 大小寫/連字號不同也要對上
        { uid: "cc", name: "P2", lastOnlineDaysAgo: 30 },
      ],
      bases: [
        { id: "b1", name: "b1", x: 0, y: 0, workers: [{ characterId: "SheepBall", level: 9 }] },
        { id: "b2", name: "b2", x: 0, y: 0, workers: [] },
      ],
      storage: [{ itemId: "Wood", count: 3 }, { itemId: "Stone", count: 1 }],
      research: { currentId: "r2", entries: [{ id: "r1", workAmount: 100 }, { id: "r2", workAmount: 5 }] },
    }],
  });
  const g = stats.guilds[0];
  assert.equal(g.avgLevel, 30);        // (40+20)/2
  assert.equal(g.maxLevel, 40);
  assert.equal(g.activeMembers, 1);    // 7 天內只有 P1
  assert.equal(g.workerPals, 1);
  assert.equal(g.storageKinds, 2);
  assert.equal(g.researchDone, 2);
  assert.equal(g.totalMoney, 1000);
  assert.equal(g.totalPals, 15);
  // 實力分數:平均30 + 活躍1×5 + 據點2×8 + 據點等級12×3 + 駐守1×0.5 + 研究2×2 = 91.5
  assert.equal(guildScore(g), 91.5);
});
