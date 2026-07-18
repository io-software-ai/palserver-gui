import assert from "node:assert/strict";
import test from "node:test";
import { patchFastTravelJson } from "./save-unlocks.js";
import { FAST_TRAVEL_GUIDS } from "./fast-travel-points.js";

/** 真實玩家存檔的最小切片(欄位形狀 2026-07-17 以 palsav 輸出逐字取樣)。 */
const fixture = () => ({
  properties: {
    SaveData: {
      struct_type: "PalWorldPlayerSaveData",
      struct_id: "00000000-0000-0000-0000-000000000000",
      id: null,
      type: "StructProperty",
      value: {
        RecordData: {
          struct_type: "PalLoggedinPlayerSaveDataRecordData",
          struct_id: "00000000-0000-0000-0000-000000000000",
          id: null,
          type: "StructProperty",
          value: {
            FastTravelPointUnlockFlag: {
              key_type: "NameProperty",
              value_type: "BoolProperty",
              key_struct_type: null,
              value_struct_type: null,
              id: null,
              type: "MapProperty",
              value: [
                { key: "6E03F8464BAD9E458B843AA30BE1CC8F", value: true },
                { key: "DDBBFFAF43D9219AE68DF98744DF0831", value: false }, // 曾看過但未解鎖
              ],
            },
          },
        },
      },
    },
  },
});

test("patchFastTravelJson:合併全清單、翻開 false、不重複既有", () => {
  const doc = fixture();
  const { before, after } = patchFastTravelJson(doc);
  assert.equal(before, 1); // 原本只有 1 個 true
  assert.equal(after, FAST_TRAVEL_GUIDS.length); // 174,兩個既有的都在清單內
  const entries = doc.properties.SaveData.value.RecordData.value.FastTravelPointUnlockFlag.value;
  assert.equal(entries.length, FAST_TRAVEL_GUIDS.length);
  assert.ok(entries.every((e: { value: boolean }) => e.value === true));
  const keys = new Set(entries.map((e: { key: string }) => e.key));
  assert.equal(keys.size, entries.length); // 無重複
});

test("patchFastTravelJson:全新玩家(無 RecordData)按實測形狀合成", () => {
  const doc: Record<string, unknown> = { properties: { SaveData: { value: {} } } };
  const { before, after } = patchFastTravelJson(doc as never);
  assert.equal(before, 0);
  assert.equal(after, FAST_TRAVEL_GUIDS.length);
  const rd = (doc as any).properties.SaveData.value.RecordData;
  assert.equal(rd.struct_type, "PalLoggedinPlayerSaveDataRecordData");
  assert.equal(rd.value.FastTravelPointUnlockFlag.key_type, "NameProperty");
  assert.equal(rd.value.FastTravelPointUnlockFlag.type, "MapProperty");
});

test("patchFastTravelJson:非玩家存檔擲錯", () => {
  assert.throws(() => patchFastTravelJson({} as never), /缺 properties\.SaveData/);
});
