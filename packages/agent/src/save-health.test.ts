import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { analyzeLevelJsonStream } from "./save-health.js";

/**
 * 合成的 Level.sav JSON 最小樣本 — 形狀照上游 palsav(pin 2c8c65c)輸出:
 * diag.py 的取值路徑 + rawdata/group.py 的公會名冊欄位。
 * 這份測試同時是「我們假設的上游 JSON 形狀」的文件化;上游改格式時先改這裡。
 */

const EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_DAY = 864_000_000_000n;

/** mtime 基準:2026-07-15T00:00:00Z */
const MTIME_MS = Date.UTC(2026, 6, 15);

function ticksDaysAgo(days: number): string {
  const now = BigInt(MTIME_MS) * 10_000n + EPOCH_TICKS;
  return String(now - BigInt(days) * TICKS_PER_DAY);
}

let instanceSeq = 0;
function charEntry(uid: string, saveParameter: Record<string, unknown>) {
  return {
    key: { PlayerUId: { value: uid }, InstanceId: { value: `inst-${++instanceSeq}` } },
    value: {
      RawData: { value: { object: { SaveParameter: { value: saveParameter } } } },
    },
  };
}

function playerEntry(uid: string, name: string, level: number) {
  return charEntry(uid, {
    IsPlayer: { value: true },
    NickName: { value: name },
    Level: { value: `__RAW_${level}__` },
    Exp: { value: `__RAW_${level * 1000}__` },
  });
}

const ZERO = "00000000-0000-0000-0000-000000000000";

function palEntry(
  owner: string,
  characterId: string,
  level: number,
  opts: { lucky?: boolean; passives?: string[]; talents?: [number, number, number]; containerId?: string } = {},
) {
  const [hp, shot, def] = opts.talents ?? [50, 50, 50];
  return charEntry(ZERO, {
    CharacterID: { value: characterId },
    SlotId: { value: { ContainerId: { value: { ID: { value: opts.containerId ?? "cont-default" } } }, SlotIndex: { value: `__RAW_0__` } } },
    Level: { value: `__RAW_${level}__` },
    Gender: { value: { type: "EPalGenderType", value: "EPalGenderType::Female" } },
    Rank: { value: `__RAW_1__` },
    ...(opts.lucky ? { IsRarePal: { value: true } } : {}),
    Talent_HP: { value: `__RAW_${hp}__` },
    Talent_Shot: { value: `__RAW_${shot}__` },
    Talent_Defense: { value: `__RAW_${def}__` },
    OwnerPlayerUId: { value: owner },
    PassiveSkillList: { value: { values: opts.passives ?? [] } },
  });
}

function guildEntry(
  name: string,
  players: { uid: string; name: string; daysAgo: number }[],
  opts: { groupId?: string; adminUid?: string; baseIds?: string[]; baseCampLevel?: number } = {},
) {
  return {
    key: { value: opts.groupId ?? "gid" },
    value: {
      GroupType: { value: { value: "EPalGroupType::Guild" } },
      RawData: {
        value: {
          group_type: "EPalGroupType::Guild",
          group_id: opts.groupId ?? "gid",
          guild_name: name,
          ...(opts.adminUid ? { admin_player_uid: opts.adminUid } : {}),
          ...(opts.baseIds ? { base_ids: opts.baseIds } : {}),
          ...(opts.baseCampLevel ? { base_camp_level: `__RAW_${opts.baseCampLevel}__` } : {}),
          players: players.map((p) => ({
            player_uid: p.uid,
            player_info: {
              // 數字用「原始 JSON 數字」寫進字串裡,見 buildJson()
              last_online_real_time: `__RAW_${ticksDaysAgo(p.daysAgo)}__`,
              player_name: p.name,
            },
          })),
        },
      },
    },
  };
}

function baseCampEntry(id: string, groupId: string, x: number, y: number) {
  return {
    key: { value: id },
    value: {
      RawData: {
        value: {
          id,
          name: "",
          state: `__RAW_0__`,
          transform: {
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            translation: { x: `__RAW_${x}__`, y: `__RAW_${y}__`, z: `__RAW_100__` },
          },
          area_range: `__RAW_2000__`,
          group_id_belong_to: groupId,
          fast_travel_local_transform: {
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            translation: { x: `__RAW_9__`, y: `__RAW_9__`, z: `__RAW_9__` },
          },
        },
      },
    },
  };
}

function orgEntry() {
  return {
    key: { value: "oid" },
    value: { RawData: { value: { group_type: "EPalGroupType::Organization", players: [] } } },
  };
}

function containerEntry(slotNum: number, items: ({ id: string; count?: number } | null)[], cid = "cid") {
  return {
    key: { ID: { value: cid } },
    value: {
      SlotNum: { value: `__RAW_${slotNum}__` },
      Slots: {
        value: {
          values: items.map((it) => ({
            RawData: {
              value: {
                slot_index: `__RAW_0__`,
                count: `__RAW_${it?.count ?? 0}__`,
                item: { static_id: it?.id ?? "None" },
              },
            },
          })),
        },
      },
    },
  };
}

function mapObject(id: string) {
  return { MapObjectId: { value: id }, Model: { value: {} } };
}

function buildJson(): string {
  const doc = {
    header: { save_game_class_name: "PalWorldSaveGame" },
    properties: {
      worldSaveData: {
        value: {
          GameTimeSaveData: {
            value: { RealDateTimeTicks: { value: `__RAW_${ticksDaysAgo(0)}__` } },
          },
          CharacterSaveParameterMap: {
            value: [
              playerEntry("p1", "Alice", 25),
              playerEntry("p2", "Bob", 18),
              palEntry("p1", "SheepBall", 12, { lucky: true, passives: ["Rare", "PAL_ALLAttack_up2"], talents: [80, 90, 100] }),
              palEntry("p1", "BOSS_Penguin", 30),
              palEntry(ZERO, "Kitsunebi", 7), // 野生/無主:不入任何玩家名下
            ],
          },
          GroupSaveDataMap: {
            value: [
              guildEntry("ActiveGuild", [
                { uid: "p1", name: "Alice", daysAgo: 2 },
                { uid: "p2", name: "Bob", daysAgo: 45 },
              ]),
              guildEntry("GhostGuild", []),
              orgEntry(),
            ],
          },
          ItemContainerSaveData: {
            value: [
              containerEntry(20, [{ id: "Wood", count: 5 }, null]),
              containerEntry(10, [null, null]),
              containerEntry(5, []),
            ],
          },
          CharacterContainerSaveData: { value: [{ key: {}, value: {} }, { key: {}, value: {} }] },
          MapObjectSaveData: {
            value: { values: [mapObject("PalBoxV2"), mapObject("DropItemBase"), mapObject("dropitem"), mapObject("Campfire")] },
          },
          DynamicItemSaveData: { value: { values: [{ a: 1 }] } },
        },
        type: "StructProperty",
      },
    },
    trailer: "AAAA",
  };
  // JSON.stringify 會把 i64 ticks 弄成 number literal 沒問題(此處僅測試),
  // 但為了保證與 orjson 相同的「大整數原樣輸出」,用佔位符替換成裸數字。
  return JSON.stringify(doc).replace(/"__RAW_(-?\d+)__"/g, "$1");
}

test("analyzeLevelJsonStream:計數與離線名單", async () => {
  const r = await analyzeLevelJsonStream(Readable.from([buildJson()]), MTIME_MS);

  assert.equal(r.counts.players, 2);
  assert.equal(r.counts.pals, 3);
  assert.equal(r.counts.guilds, 2); // org 不算
  assert.equal(r.counts.guildsEmpty, 1);
  assert.deepEqual(r.emptyGuildNames, ["GhostGuild"]);

  assert.equal(r.counts.itemContainers, 3);
  assert.equal(r.counts.itemContainersEmpty, 2); // 全空 + 零槽
  assert.equal(r.counts.itemSlots, 35);
  assert.equal(r.counts.charContainers, 2);

  assert.equal(r.counts.mapObjects, 4);
  assert.equal(r.counts.dropItems, 2); // DropItemBase + dropitem(大小寫不敏感)
  assert.equal(r.counts.dynamicItems, 1);

  // Alice 2 天前上線(未達 30 天)不列;Bob 45 天列入
  assert.equal(r.counts.playersInactive30d, 1);
  assert.equal(r.inactivePlayers.length, 1);
  assert.equal(r.inactivePlayers[0].name, "Bob");
  assert.equal(r.inactivePlayers[0].uid, "p2");
  assert.equal(r.inactivePlayers[0].guildName, "ActiveGuild");
  assert.equal(r.inactivePlayers[0].lastOnlineDaysAgo, 45);
});

test("analyzeLevelJsonStream:玩家快照(檔案+帕魯明細)", async () => {
  const r = await analyzeLevelJsonStream(Readable.from([buildJson()]), MTIME_MS);

  assert.equal(r.players.length, 2);
  const alice = r.players.find((p) => p.uid === "p1")!;
  assert.equal(alice.name, "Alice");
  assert.equal(alice.level, 25);
  assert.equal(alice.exp, 25000);
  assert.equal(alice.guildName, "ActiveGuild");
  assert.equal(alice.lastOnlineDaysAgo, 2);
  assert.equal(alice.palCount, 2);
  // 依等級降冪:BOSS_Penguin(30) 在前
  assert.equal(alice.pals[0].characterId, "BOSS_Penguin");
  assert.equal(alice.pals[0].isBoss, true);
  assert.equal(alice.pals[0].gender, "female");
  // 每隻帕魯都帶存檔的 InstanceId(跨資料來源比對用)
  assert.ok(alice.pals.every((p) => p.instanceId.startsWith("inst-")));
  const sheep = alice.pals[1];
  assert.equal(sheep.characterId, "SheepBall");
  assert.equal(sheep.isLucky, true);
  assert.deepEqual([sheep.talentHp, sheep.talentShot, sheep.talentDefense], [80, 90, 100]);
  assert.deepEqual(sheep.passives, ["Rare", "PAL_ALLAttack_up2"]);
  assert.equal(sheep.rank, 1);

  const bob = r.players.find((p) => p.uid === "p2")!;
  assert.equal(bob.palCount, 0);
  assert.equal(bob.lastOnlineDaysAgo, 45);
  // 野生帕魯不掛在任何玩家名下,但總數仍計 3
  assert.equal(r.counts.pals, 3);
});

test("analyzeLevelJsonStream:離線天數以存檔內世界時鐘為準,mtime 只是 fallback", async () => {
  // mtime 比世界時鐘晚 100 天:若誤用 mtime,Bob 會變 145 天;正確應仍是 45
  const skewedMtime = MTIME_MS + 100 * 24 * 3600 * 1000;
  const r = await analyzeLevelJsonStream(Readable.from([buildJson()]), skewedMtime);
  assert.equal(r.inactivePlayers[0]?.lastOnlineDaysAgo, 45);

  // 世界時鐘缺失(合成資料拿掉 GameTimeSaveData)→ 退回 mtime 基準
  const noClock = buildJson().replace(/"GameTimeSaveData":\{[^}]*\}\}\},/, "");
  const r2 = await analyzeLevelJsonStream(Readable.from([noClock]), MTIME_MS);
  assert.equal(r2.inactivePlayers[0]?.lastOnlineDaysAgo, 45);
});

test("analyzeLevelJsonStream:帕魯位置依容器對照分類(party/palbox/base/unknown)", async () => {
  const doc = {
    properties: {
      worldSaveData: {
        value: {
          CharacterSaveParameterMap: {
            value: [
              playerEntry("p1", "X", 1),
              palEntry("p1", "A", 1, { containerId: "AABB-01" }), // party
              palEntry("p1", "B", 2, { containerId: "aabb02" }), // palbox(正規化後相同)
              palEntry("p1", "C", 3, { containerId: "cccc-03" }), // 不在對照 → base
            ],
          },
        },
      },
    },
  };
  const json = JSON.stringify(doc).replace(/"__RAW_(-?\d+)__"/g, "$1");
  const kinds = new Map<string, "party" | "palbox">([
    ["aabb01", "party"],
    ["aabb02", "palbox"],
  ]);
  const r = await analyzeLevelJsonStream(Readable.from([json]), MTIME_MS, { containerKinds: kinds });
  const pals = r.players.find((p) => p.uid === "p1")!.pals;
  const locOf = (id: string) => pals.find((p) => p.characterId === id)!.location;
  assert.equal(locOf("A"), "party");
  assert.equal(locOf("B"), "palbox");
  assert.equal(locOf("C"), "base");

  // 沒給對照表 → 全部 unknown
  const r2 = await analyzeLevelJsonStream(Readable.from([json]), MTIME_MS);
  assert.ok(r2.players[0].pals.every((p) => p.location === "unknown"));
});

test("analyzeLevelJsonStream:公會職位/據點座標/加點分配", async () => {
  const doc = {
    properties: {
      worldSaveData: {
        value: {
          CharacterSaveParameterMap: {
            value: [
              charEntry("p1", {
                IsPlayer: { value: true },
                NickName: { value: "Alice" },
                Level: { value: `__RAW_30__` },
                UnusedStatusPoint: { value: `__RAW_4__` },
                GotStatusPointList: {
                  value: {
                    values: [
                      { StatusName: { value: "最大HP" }, StatusPoint: { value: `__RAW_10__` } },
                      { StatusName: { value: "所持重量" }, StatusPoint: { value: `__RAW_25__` } },
                    ],
                  },
                },
                GotExStatusPointList: {
                  value: { values: [{ StatusName: { value: "最大HP" }, StatusPoint: { value: `__RAW_2__` } }] },
                },
              }),
            ],
          },
          GroupSaveDataMap: {
            value: [
              guildEntry("G", [{ uid: "p1", name: "Alice", daysAgo: 1 }, { uid: "p2", name: "Bob", daysAgo: 2 }], {
                groupId: "9999-aa",
                adminUid: "p1",
                baseIds: ["BB-01", "bb02"],
                baseCampLevel: 12,
              }),
            ],
          },
          BaseCampSaveData: {
            value: [
              baseCampEntry("bb01", "9999aa", 123456, -654321),
              baseCampEntry("BB-02", "9999aa", 111, 222),
              baseCampEntry("cc03", "other", 9, 9), // 別的公會
            ],
          },
        },
      },
    },
  };
  const json = JSON.stringify(doc).replace(/"__RAW_(-?\d+)__"/g, "$1");
  const r = await analyzeLevelJsonStream(Readable.from([json]), MTIME_MS);
  const alice = r.players.find((p) => p.uid === "p1")!;

  assert.equal(alice.guild!.name, "G");
  assert.equal(alice.guild!.role, "admin");
  assert.equal(alice.guild!.memberCount, 2);
  assert.equal(alice.guild!.baseCampLevel, 12);
  // base_ids 與據點 id 的表示法差異(大小寫/連字號)要對得起來
  assert.deepEqual(
    alice.guild!.bases.map((b) => [b.x, b.y]),
    [[123456, -654321], [111, 222]], // fast_travel 的 (9,9) 不能混進來
  );

  const bob = r.players.find((p) => p.uid === "p2")!;
  assert.equal(bob.guild!.role, "member");

  assert.deepEqual(alice.statusPoints, [
    { name: "最大HP", points: 12 }, // 10 + Ex 2
    { name: "所持重量", points: 25 },
  ]);
  assert.equal(alice.unusedStatusPoints, 4);

  // section 診斷清單
  assert.ok(r.worldSections.includes("BaseCampSaveData"));
  assert.ok(r.worldSections.includes("GroupSaveDataMap"));
});

test("analyzeLevelJsonStream:離線物品(背包/裝備/金錢)依容器歸屬收集", async () => {
  const doc = {
    properties: {
      worldSaveData: {
        value: {
          CharacterSaveParameterMap: { value: [playerEntry("p1", "X", 9)] },
          ItemContainerSaveData: {
            value: [
              containerEntry(30, [{ id: "Wood", count: 42 }, { id: "Money", count: 12345 }, { id: "Stone", count: 7 }], "ABC0-01"),
              containerEntry(4, [{ id: "AssaultRifle_Default1", count: 1 }], "abc002"),
              containerEntry(8, [{ id: "Berries", count: 3 }], "abc999"),
            ],
          },
        },
      },
    },
  };
  const json = JSON.stringify(doc).replace(/"__RAW_(-?\d+)__"/g, "$1");
  const owners = new Map<string, { uid: string; kind: "common" | "essential" | "weapons" | "armor" | "food" }>([
    ["abc001", { uid: "p1", kind: "common" }], // 對照 "ABC0-01" 正規化後
    ["abc002", { uid: "p1", kind: "weapons" }],
  ]);
  const r = await analyzeLevelJsonStream(Readable.from([json]), MTIME_MS, { itemContainerOwners: owners });
  const inv = r.players.find((p) => p.uid === "p1")!.inventory!;
  assert.equal(inv.money, 12345); // Money 抽出,不進背包清單
  assert.deepEqual(inv.common, [{ itemId: "Wood", count: 42 }, { itemId: "Stone", count: 7 }]);
  assert.deepEqual(inv.weapons, [{ itemId: "AssaultRifle_Default1", count: 1 }]);
  assert.deepEqual(inv.food, []); // 沒對到的容器(別人的)不會混進來

  // 沒給容器歸屬 → inventory 為 null(舊快照語意)
  const r2 = await analyzeLevelJsonStream(Readable.from([json]), MTIME_MS);
  assert.equal(r2.players[0].inventory, null);
});

test("analyzeLevelJsonStream:荒謬 ticks 回 null 而非硬湊", async () => {
  const doc = {
    properties: {
      worldSaveData: {
        value: {
          GroupSaveDataMap: {
            value: [
              guildEntry("G", [{ uid: "p9", name: "Weird", daysAgo: 9999 }]), // 超出 sanity 範圍
            ],
          },
        },
      },
    },
  };
  const json = JSON.stringify(doc).replace(/"__RAW_(-?\d+)__"/g, "$1");
  const r = await analyzeLevelJsonStream(Readable.from([json]), MTIME_MS);
  assert.equal(r.counts.guilds, 1);
  assert.equal(r.counts.playersInactive30d, 0); // days=null 不計入不活躍
  assert.equal(r.inactivePlayers.length, 0);
});

test("analyzeLevelJsonStream:壞 JSON 以錯誤收場", async () => {
  await assert.rejects(
    () => analyzeLevelJsonStream(Readable.from(['{"properties": {broken']), MTIME_MS),
    /解析失敗/,
  );
});
