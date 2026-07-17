import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverRoot } from "./native.js";
import { activeWorldGuid, createBackup } from "./saves.js";
import { ensurePalsav, palsavAssetName } from "./save-tools.js";
import { FAST_TRAVEL_GUIDS } from "./fast-travel-points.js";

const execFileP = promisify(execFile);

/**
 * 存檔解鎖(贊助者 map-unlocks):改寫「玩家個人存檔」的 RecordData。
 * 目前提供「快速傳送全開」— 把全部快速傳送點 GUID 寫進每個玩家的
 * FastTravelPointUnlockFlag(MapProperty NameProperty→BoolProperty)。
 *
 * 結構與 GUID 皆以真實存檔驗證(2026-07-17;路徑
 * properties.SaveData.value.RecordData.value.FastTravelPointUnlockFlag,
 * GUID 為遊戲靜態資產、跨世界一致 — 不存在於 Level.sav)。
 *
 * 安全姿態:僅伺服器停止時可執行(路由把關);動手前整世界備份;
 * 逐檔「暫存寫入→原子 rename」,單檔失敗不影響其他玩家檔。
 * 轉換走 palsav(json↔sav 已實測位元組等值往返)。
 */


/** 把 GUID 清單合併進玩家存檔 JSON(缺的層級按實測 GVAS 形狀合成)。 */
export function patchFastTravelJson(
  doc: Record<string, any>,
  guids: string[] = FAST_TRAVEL_GUIDS,
): { before: number; after: number } {
  const sd = doc?.properties?.SaveData;
  if (!sd || typeof sd !== "object") throw new Error("不是玩家存檔(缺 properties.SaveData)");
  sd.value ??= {};
  let rd = sd.value.RecordData;
  if (!rd || typeof rd !== "object") {
    rd = sd.value.RecordData = {
      struct_type: "PalLoggedinPlayerSaveDataRecordData",
      struct_id: "00000000-0000-0000-0000-000000000000",
      id: null,
      value: {},
      type: "StructProperty",
    };
  }
  rd.value ??= {};
  let flag = rd.value.FastTravelPointUnlockFlag;
  if (!flag || typeof flag !== "object") {
    flag = rd.value.FastTravelPointUnlockFlag = {
      key_type: "NameProperty",
      value_type: "BoolProperty",
      key_struct_type: null,
      value_struct_type: null,
      id: null,
      value: [],
      type: "MapProperty",
    };
  }
  flag.value ??= [];
  const entries = flag.value as { key: string; value: boolean }[];
  const seen = new Set(entries.map((e) => String(e.key).toUpperCase()));
  const before = entries.filter((e) => e.value === true).length;
  for (const e of entries) e.value = true; // 原本 false 的一併翻開
  for (const g of guids) {
    if (!seen.has(g.toUpperCase())) {
      entries.push({ key: g, value: true });
      seen.add(g.toUpperCase());
    }
  }
  return { before, after: entries.length };
}

export interface UnlockResult {
  file: string;
  ok: boolean;
  /** 解鎖前已開的點數 → 解鎖後總點數;失敗時為錯誤訊息。 */
  detail: string;
}

export function saveUnlocksSupport(rec: InstanceRecord): { supported: boolean; reason?: string } {
  if (rec.backend !== "native") return { supported: false, reason: "存檔解鎖僅支援原生模式" };
  if (!palsavAssetName(rec) && !process.env.PALSERVER_PALSAV_BIN) {
    return { supported: false, reason: "此主機平台不支援存檔工具(需 x64 Windows/Linux)" };
  }
  return { supported: true };
}

/** 對世界內全部玩家檔解鎖快速傳送。呼叫端需確保伺服器已停止。 */
export async function unlockAllFastTravel(
  rec: InstanceRecord,
  ctx: DriverContext,
): Promise<{ worldGuid: string; players: UnlockResult[]; total: number }> {
  const support = saveUnlocksSupport(rec);
  if (!support.supported) throw Object.assign(new Error(support.reason), { statusCode: 409 });
  if (FAST_TRAVEL_GUIDS.length === 0) {
    throw Object.assign(new Error("快速傳送點清單尚未內建,請更新 agent"), { statusCode: 500 });
  }
  const root = serverRoot(rec, ctx);
  const guid = activeWorldGuid(root);
  if (!guid) throw Object.assign(new Error("找不到啟用中的世界存檔"), { statusCode: 409 });

  const playersDir = path.join(root, "Pal", "Saved", "SaveGames", "0", guid, "Players");
  if (!fs.existsSync(playersDir)) {
    throw Object.assign(new Error("找不到玩家存檔資料夾(還沒有玩家加入過?)"), { statusCode: 409 });
  }
  const files = fs.readdirSync(playersDir).filter((f) => f.toLowerCase().endsWith(".sav"));
  if (files.length === 0) {
    throw Object.assign(new Error("沒有任何玩家存檔"), { statusCode: 409 });
  }

  // 動手前整世界備份(含 Players/);失敗就中止,不做沒有退路的寫入。
  await createBackup(rec, ctx, guid);

  const bin = process.env.PALSERVER_PALSAV_BIN ?? (await ensurePalsav(rec));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palunlock-"));
  const players: UnlockResult[] = [];
  try {
    for (const file of files) {
      const src = path.join(playersDir, file);
      const jsonPath = path.join(tmp, `${file}.json`);
      const outSav = path.join(tmp, `${file}.new`);
      try {
        // 參數形式沿用 save-tools 既有呼叫(無子指令);from-json 走 convert 子指令(皆實測)
        await execFileP(bin, ["--to-json", "-o", jsonPath, "--minify-json", "-f", src], {
          windowsHide: true,
          timeout: 5 * 60_000,
        });
        const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        const { before, after } = patchFastTravelJson(doc);
        fs.writeFileSync(jsonPath, JSON.stringify(doc));
        await execFileP(bin, ["convert", "--from-json", "-o", outSav, jsonPath], {
          windowsHide: true,
          timeout: 5 * 60_000,
        });
        if (!fs.existsSync(outSav) || fs.statSync(outSav).size === 0) throw new Error("轉回 .sav 失敗(輸出為空)");
        // 原子替換:先寫進同資料夾暫名再 rename,避免寫到一半的檔案
        const staged = path.join(playersDir, `${file}.palserver-new`);
        fs.copyFileSync(outSav, staged);
        fs.renameSync(staged, src);
        players.push({ file, ok: true, detail: `${before} → ${after}` });
      } catch (err) {
        players.push({ file, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { worldGuid: guid, players, total: FAST_TRAVEL_GUIDS.length };
}
