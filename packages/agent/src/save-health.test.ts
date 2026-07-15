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
  opts: { lucky?: boolean; passives?: string[]; talents?: [number, number, number] } = {},
) {
  const [hp, shot, def] = opts.talents ?? [50, 50, 50];
  return charEntry(ZERO, {
    CharacterID: { value: characterId },
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

function guildEntry(name: string, players: { uid: string; name: string; daysAgo: number }[]) {
  return {
    key: { value: "gid" },
    value: {
      GroupType: { value: { value: "EPalGroupType::Guild" } },
      RawData: {
        value: {
          group_type: "EPalGroupType::Guild",
          guild_name: name,
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

function orgEntry() {
  return {
    key: { value: "oid" },
    value: { RawData: { value: { group_type: "EPalGroupType::Organization", players: [] } } },
  };
}

function containerEntry(slotNum: number, itemIds: (string | null)[]) {
  return {
    key: { ID: { value: "cid" } },
    value: {
      SlotNum: { value: `__RAW_${slotNum}__` },
      Slots: {
        value: {
          values: itemIds.map((id) => ({
            RawData: { value: { item: { static_id: id ?? "None" } } },
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
            value: [containerEntry(20, ["Wood", null]), containerEntry(10, [null, null]), containerEntry(5, [])],
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
