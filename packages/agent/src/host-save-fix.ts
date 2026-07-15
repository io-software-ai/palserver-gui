import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { HostFixResult } from "@palserver/shared";
import { oodleDecompress } from "./oodle.js";

/**
 * 內建版 palworld-host-save-fix(github.com/xNul/palworld-host-save-fix)。
 *
 * 用途:本機共玩存檔搬上專用伺服器後,主機玩家的角色綁在固定的
 * PlayerUid 00000000-…-0001 上,而專用伺服器給他的是新 Uid → 進來被要求重建角色。
 * 修法 = 把舊角色資料過戶給新 Uid:改玩家 .sav 的兩個 PlayerUId 欄位、
 * 改 Level.sav 裡該角色條目的 PlayerUId,再把玩家檔改名成 <新Uid>.sav。
 *
 * 實作方式與參考工具不同:不做完整 GVAS 解析,而是「錨定式二進位補丁」——
 * 以屬性名 FString("PlayerUId"/"InstanceId") + "StructProperty" + "Guid" 的
 * 位元組序列為錨點定位 Guid 值,驗證舊值完全符合才改寫。沒動到的位元組
 * 保證原封不動,避開了「整檔重新序列化必須 bit-exact」的風險。
 * 格式依據:cheahjs/palworld-save-tools 的 palsav.py(容器)與 archive.py(UUID 位元組序),
 * 已用該 repo 的真實測試存檔(共玩主機玩家檔 + Level.sav)驗證錨點命中。
 *
 * 範圍:等同參考工具 guild_fix=False 的主路徑。公會欄位修補(參考工具自己
 * 都標 experimental 且有已知 bug)不做 —— 公會異常時的解法同官方建議:
 * 該玩家退出公會再重新加入。
 */

/* ── 存檔容器:PlZ(zlib,舊版)與 PlM(Oodle,新版)── */

const MAGIC_ZLIB = "PlZ";
const MAGIC_OODLE = "PlM";

async function decompressSav(buf: Buffer): Promise<{ data: Buffer; saveType: number }> {
  let off = 0;
  let uncompressedLen = buf.readUInt32LE(0);
  let magic = buf.subarray(8, 11).toString("latin1");
  let saveType = buf[11];
  off = 12;
  if (magic === "CNK") {
    // 選配的 CNK 前綴:整組 header 後移 12 bytes
    uncompressedLen = buf.readUInt32LE(12);
    magic = buf.subarray(20, 23).toString("latin1");
    saveType = buf[23];
    off = 24;
  }
  if (magic === MAGIC_OODLE) {
    // 新版存檔:payload 是 Oodle 壓縮流(實測為 Mermaid)。只看過 0x31,其他值先擋。
    if (saveType !== 0x31) throw fail(`不支援的 PlM 存檔壓縮類型 0x${saveType.toString(16)}`, 422);
    const data = await oodleDecompress(buf.subarray(off), uncompressedLen);
    return { data, saveType };
  }
  if (magic !== MAGIC_ZLIB) throw fail(`不是 Palworld 存檔(magic=${JSON.stringify(magic)})`, 422);
  if (saveType !== 0x31 && saveType !== 0x32) throw fail(`不支援的存檔壓縮類型 0x${saveType.toString(16)}`, 422);
  let data = zlib.inflateSync(buf.subarray(off));
  if (saveType === 0x32) data = zlib.inflateSync(data);
  if (data.length !== uncompressedLen) throw fail("存檔長度驗證失敗,檔案可能已損毀", 422);
  return { data, saveType };
}

/** 寫回一律用 zlib 的 PlZ 容器 —— 即使來源是 PlM(Oodle):遊戲兩種都讀
 *  (歷次改版舊 PlZ 存檔都載得起來),這樣就不需要實作 Oodle 壓縮。 */
function compressSav(data: Buffer, saveType: number): Buffer {
  let comp = zlib.deflateSync(data);
  const compLen = comp.length;
  if (saveType === 0x32) comp = zlib.deflateSync(comp);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(data.length, 0);
  head.writeUInt32LE(compLen, 4);
  head.write(MAGIC_ZLIB, 8, "latin1");
  head[11] = saveType;
  return Buffer.concat([head, comp]);
}

/* ── UUID ↔ 位元組(archive.py 的 4-byte 區塊反轉序)── */

const UUID_BYTE_ORDER = [3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12] as const;

function uuidToRaw(s: string): Buffer {
  const hex = s.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw fail(`PlayerUid 格式不合法:${s}`, 422);
  const b = Buffer.from(hex, "hex");
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = b[UUID_BYTE_ORDER[i]];
  return out;
}

function rawToUuid(raw: Buffer): string {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[UUID_BYTE_ORDER[i]] = raw[i];
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ── 錨定式 Guid 屬性掃描 ── */

/** GVAS FString:int32 長度(含結尾 \0)+ ascii bytes + \0。 */
function fstr(name: string): Buffer {
  const b = Buffer.alloc(4 + name.length + 1);
  b.writeInt32LE(name.length + 1, 0);
  b.write(name, 4, "latin1");
  return b;
}

const STRUCT_PROP = fstr("StructProperty");
const GUID_TYPE = fstr("Guid");

interface GuidProp {
  /** Guid 值(16 bytes)在 GVAS buffer 中的起始 offset。 */
  offset: number;
  uuid: string;
}

/** 找出所有「名為 propName 的 Guid 屬性」。
 *  錨點 = FString(propName) + FString("StructProperty") + u64 size(16) +
 *  FString("Guid") + 16B struct-guid + 1B flag,之後 16B 即為值。 */
function findGuidProps(data: Buffer, propName: string): GuidProp[] {
  const anchor = Buffer.concat([fstr(propName), STRUCT_PROP]);
  const out: GuidProp[] = [];
  let idx = 0;
  while ((idx = data.indexOf(anchor, idx)) !== -1) {
    let p = idx + anchor.length;
    idx += anchor.length;
    if (p + 8 + GUID_TYPE.length + 17 + 16 > data.length) continue;
    const size = Number(data.readBigUInt64LE(p));
    p += 8;
    if (size !== 16) continue;
    if (Buffer.compare(data.subarray(p, p + GUID_TYPE.length), GUID_TYPE) !== 0) continue;
    p += GUID_TYPE.length + 16 + 1; // struct guid(全零) + has-guid flag
    out.push({ offset: p, uuid: rawToUuid(data.subarray(p, p + 16)) });
  }
  return out;
}

function fail(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

const SAV_NAME_RE = /^[0-9A-Fa-f]{32}\.sav$/;

/** 檔名(32 hex).sav → 連字號小寫 uuid 字串。 */
function savNameToUuid(name: string): string {
  const h = name.slice(0, 32).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 執行主機角色修復。呼叫端負責:確認伺服器已停止、先做備份。
 * @param worldDir 世界資料夾(…/SaveGames/0/<guid>)
 * @param oldSavName 舊角色檔名(通常 00000000…0001.sav)
 * @param newSavName 新角色檔名(該玩家加入專用伺服器後產生的)
 */
export async function applyHostFix(
  worldDir: string,
  oldSavName: string,
  newSavName: string,
): Promise<Omit<HostFixResult, "backup">> {
  if (!SAV_NAME_RE.test(oldSavName) || !SAV_NAME_RE.test(newSavName)) {
    throw fail("玩家存檔檔名格式不合法", 422);
  }
  if (oldSavName.toLowerCase() === newSavName.toLowerCase()) {
    throw fail("新舊角色檔相同,不需修復", 422);
  }
  const playersDir = path.join(worldDir, "Players");
  const oldPath = path.join(playersDir, oldSavName);
  const newPath = path.join(playersDir, newSavName);
  const levelPath = path.join(worldDir, "Level.sav");
  if (!fs.existsSync(oldPath)) throw fail(`找不到舊角色檔 ${oldSavName}`, 404);
  if (!fs.existsSync(newPath)) {
    throw fail(`找不到新角色檔 ${newSavName} — 該玩家要先用自己的帳號加入伺服器一次`, 404);
  }
  if (!fs.existsSync(levelPath)) throw fail("找不到 Level.sav", 404);

  const oldUid = savNameToUuid(oldSavName);
  const newUid = savNameToUuid(newSavName);
  const oldRaw = uuidToRaw(oldUid);
  const newRaw = uuidToRaw(newUid);

  // ── 玩家檔:改 SaveData.PlayerUId 與 SaveData.IndividualId.PlayerUId(恰 2 處),
  //    並讀出 IndividualId.InstanceId 當 Level.sav 的比對錨。
  const oldPlayer = await decompressSav(fs.readFileSync(oldPath));
  const uidProps = findGuidProps(oldPlayer.data, "PlayerUId");
  const matching = uidProps.filter((p) => p.uuid === oldUid);
  if (uidProps.length !== 2 || matching.length !== 2) {
    throw fail(
      `舊角色檔的 PlayerUId 欄位不符預期(找到 ${uidProps.length} 個,其中 ${matching.length} 個等於 ${oldUid})— 檔案格式可能已變更,已中止以免壞檔`,
      422,
    );
  }
  const instProps = findGuidProps(oldPlayer.data, "InstanceId");
  if (instProps.length !== 1) {
    throw fail(`舊角色檔的 InstanceId 欄位不符預期(找到 ${instProps.length} 個)— 已中止以免壞檔`, 422);
  }
  const instanceUid = instProps[0].uuid;
  const instRaw = uuidToRaw(instanceUid);
  for (const p of matching) newRaw.copy(oldPlayer.data, p.offset);

  // ── Level.sav:CharacterSaveParameterMap 裡「PlayerUId==舊 && 後隨 InstanceId==角色實例」
  //    的那一筆,把 PlayerUId 改成新的。錨定要求 InstanceId 緊跟在同一條目內(≤256 bytes)。
  const level = await decompressSav(fs.readFileSync(levelPath));
  const levelUids = findGuidProps(level.data, "PlayerUId");
  const targets: number[] = [];
  for (const p of levelUids) {
    if (p.uuid !== oldUid) continue;
    const windowEnd = Math.min(p.offset + 16 + 256, level.data.length);
    const windowBuf = level.data.subarray(p.offset + 16, windowEnd);
    const anchor = Buffer.concat([fstr("InstanceId"), STRUCT_PROP]);
    const rel = windowBuf.indexOf(anchor);
    if (rel === -1) continue;
    const instOff = p.offset + 16 + rel + anchor.length + 8 + GUID_TYPE.length + 16 + 1;
    if (Buffer.compare(level.data.subarray(instOff, instOff + 16), instRaw) === 0) {
      targets.push(p.offset);
    }
  }
  if (targets.length !== 1) {
    throw fail(
      `Level.sav 裡符合該角色(InstanceId=${instanceUid})的條目數不符預期(${targets.length},應為 1)— 已中止以免壞檔`,
      422,
    );
  }
  newRaw.copy(level.data, targets[0]);
  void oldRaw; // 舊值已由 matching 過濾驗證

  // ── 帕魯過戶:CharacterSaveParameterMap 裡帕魯的 OwnerPlayerUId 還掛在舊 uid 上
  //    (擁有者顯示、統計歸屬、以及清理類工具的歸屬判斷都看這個欄位)。
  //    OwnerPlayerUId 是具名 GVAS 屬性,可用與 PlayerUId 相同的錨點安全定位;
  //    只改「值 == 舊 uid」的,一隻不多一隻不少。
  //    (OldOwnerPlayerUIds 是歷史紀錄陣列,元素無具名錨點且不影響行為,不動。)
  const owners = findGuidProps(level.data, "OwnerPlayerUId").filter((p) => p.uuid === oldUid);
  for (const p of owners) newRaw.copy(level.data, p.offset);

  // ── 寫回:玩家檔內容落到 <新Uid>.sav(覆蓋加入時產生的空角色),刪舊檔;Level.sav 原地覆寫。
  fs.writeFileSync(newPath, compressSav(oldPlayer.data, oldPlayer.saveType));
  fs.rmSync(oldPath, { force: true });
  fs.writeFileSync(levelPath, compressSav(level.data, level.saveType));

  return { oldUid, newUid, patchedLevelEntries: targets.length, patchedPalOwners: owners.length };
}

/**
 * 獨立的帕魯歸屬過戶:把 Level.sav 裡「OwnerPlayerUId == fromUid」的帕魯全部
 * 過戶給 toUid。給「主機角色已修復(或重建),但帕魯還掛在共玩殘留 uid」的世界用
 * —— 這種情況舊角色檔已不存在,applyHostFix 跑不了。
 * 呼叫端負責:確認伺服器已停止、先做備份。
 */
export async function transferPalOwners(
  worldDir: string,
  fromUid: string,
  toSavName: string,
): Promise<{ fromUid: string; toUid: string; patchedPalOwners: number }> {
  if (!SAV_NAME_RE.test(toSavName)) throw fail("目標玩家存檔檔名格式不合法", 422);
  const toUid = savNameToUuid(toSavName);
  if (fromUid.toLowerCase() === toUid.toLowerCase()) throw fail("來源與目標相同,不需過戶", 422);
  const toPath = path.join(worldDir, "Players", toSavName);
  if (!fs.existsSync(toPath)) throw fail(`找不到目標玩家存檔 ${toSavName}`, 404);
  const levelPath = path.join(worldDir, "Level.sav");
  if (!fs.existsSync(levelPath)) throw fail("找不到 Level.sav", 404);

  const level = await decompressSav(fs.readFileSync(levelPath));
  const owners = findGuidProps(level.data, "OwnerPlayerUId").filter((p) => p.uuid === fromUid.toLowerCase());
  if (owners.length === 0) {
    throw fail(`Level.sav 裡沒有掛在 ${fromUid} 名下的帕魯,不需過戶`, 404);
  }
  const toRaw = uuidToRaw(toUid);
  for (const p of owners) toRaw.copy(level.data, p.offset);
  fs.writeFileSync(levelPath, compressSav(level.data, level.saveType));

  return { fromUid, toUid, patchedPalOwners: owners.length };
}
