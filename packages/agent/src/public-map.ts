import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  DEFAULT_PUBLIC_MAP_SETTINGS,
  isWorldTreeCoord,
  savToMap,
  savToWorldTreeMap,
  type PublicMapArea,
  type PublicMapBasePoint,
  type PublicMapPlayerPoint,
  type PublicMapPublishResult,
  type PublicMapSettings,
  type PublicMapSnapshot,
  type PublicMapStatus,
} from "@palserver/shared";
import { STATS_URLS, PALSERVER_MAP_VIEWER, DATA_DIR } from "./env.js";
import type { InstanceRecord, InstanceStore } from "./store.js";
import type { DriverContext, ServerDriver } from "./driver.js";
import { getLiveStatus } from "./restapi.js";
import { getPdPlayers, getPdGuilds } from "./paldefender-rest.js";
import { featureEnabled } from "./license.js";
import type { PresenceTracker } from "./presence.js";

/**
 * 公開地圖:服主一鍵把地圖公開到全網。贊助者先行版功能(public-map,見 @palserver/shared
 * 的 features.ts)。
 *
 * 資料流向:agent 定期(每 60 秒)組一份「已依設定過濾」的快照,推到雲端 Worker
 * (`POST {STATS_URL}/api/map/publish`);公開 viewer 只讀 Worker,從不直連 agent。
 * **過濾一律在這裡完成** —— 絕不把未過濾的原始資料送出去再指望前端藏欄位。
 *
 * 授權:開啟(enabled false→true)與換連結(rotate)在 routes.ts 那層擋;已經開啟後
 * 授權過期,tickOne 會自動跳過發布(不清設定、不 unpublish),授權恢復就自動續發 ——
 * 關閉與查看狀態則永遠放行,讓過期的服主仍能把已公開的地圖關掉。
 *
 * 持久化:每實例的設定(PublicMapSettings,前端可見)與發布金鑰(secret,前端不可見)
 * 存在 `<instanceDir>/public-map.json`,存放慣例比照 backup-schedule.json / presence.json
 * (store.instanceDir() 底下的一個 JSON 檔)。上次發布結果只存在記憶體 —— agent 重啟後
 * 歸零沒關係,下個 tick 就會補上。
 */

const TICK_MS = 60_000;
/** delay 緩衝最多保留多久 — 涵蓋最大 delayMinutes(15)再留一點餘裕。 */
const BUFFER_MAX_AGE_MS = 20 * 60_000;
const FETCH_TIMEOUT_MS = 8000;

interface StoredState {
  settings: PublicMapSettings;
  /** 發布金鑰 —— 只有 agent 自己與雲端 Worker 知道,絕不回給前端。 */
  secret?: string;
}

interface BufferedSnapshot {
  at: number;
  snapshot: PublicMapSnapshot;
}

// ── 純函式:快照組裝、匿名化、delay 緩衝挑選 —— 不碰網路/檔案,方便單元測試 ──

export interface PublicMapRawPlayer {
  userId: string;
  name: string;
  level: number;
  /** sav(世界)座標;assemblePublicMapSnapshot 內部轉成地圖座標。 */
  savX: number;
  savY: number;
}

export interface PublicMapRawBase {
  worldX: number;
  worldY: number;
  guildName?: string;
}

export interface PublicMapAssembleInput {
  serverName: string;
  onlineCount: number;
  maxPlayers?: number;
  online: PublicMapRawPlayer[];
  offline: PublicMapRawPlayer[];
  bases: PublicMapRawBase[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function toMapPoint(savX: number, savY: number): { x: number; y: number; m: PublicMapArea } {
  if (isWorldTreeCoord(savX)) {
    const { x, y } = savToWorldTreeMap(savX, savY);
    return { x: round1(x), y: round1(y), m: "tree" };
  }
  const { x, y } = savToMap(savX, savY);
  return { x: round1(x), y: round1(y), m: "world" };
}

/** uid → 穩定的匿名代號(Player 1..n)。按 uid 字母序排,同一組 uid 不論輸入順序、
 *  不論呼叫幾次都得到同樣的代號 —— 這是「顯示玩家名稱」關閉時的匿名化規則。 */
export function anonymizedLabels(userIds: string[]): Map<string, string> {
  const sorted = [...new Set(userIds)].sort((a, b) => a.localeCompare(b));
  return new Map(sorted.map((id, i) => [id, `Player ${i + 1}`]));
}

function mapPlayers(list: PublicMapRawPlayer[], showNames: boolean): PublicMapPlayerPoint[] {
  const labels = showNames ? null : anonymizedLabels(list.map((p) => p.userId));
  return list.map((p) => ({
    n: showNames ? p.name : labels!.get(p.userId)!,
    lv: p.level,
    ...toMapPoint(p.savX, p.savY),
  }));
}

/** 組出過濾後的快照(v1)。guildNamesUnlocked = featureEnabled("guild-map") 的結果,
 *  由呼叫端決定 —— 這個函式本身不碰授權模組,方便單元測試。 */
export function assemblePublicMapSnapshot(
  input: PublicMapAssembleInput,
  settings: PublicMapSettings,
  guildNamesUnlocked: boolean,
  now: number = Date.now(),
): PublicMapSnapshot {
  const show = {
    players: settings.showPlayers,
    names: settings.showPlayerNames,
    offline: settings.showOfflinePlayers,
    bases: settings.showBases,
    guildNames: settings.showGuildNames && guildNamesUnlocked,
  };
  const snapshot: PublicMapSnapshot = {
    v: 1,
    name: input.serverName,
    generatedAt: now,
    onlineCount: input.onlineCount,
    show,
  };
  if (input.maxPlayers != null) snapshot.maxPlayers = input.maxPlayers;
  if (show.players) snapshot.players = mapPlayers(input.online, show.names);
  if (show.offline) snapshot.offline = mapPlayers(input.offline, show.names);
  if (show.bases) {
    snapshot.bases = input.bases.map((b) => {
      const pt = toMapPoint(b.worldX, b.worldY);
      return show.guildNames && b.guildName ? { ...pt, g: b.guildName } : pt;
    });
  }
  return snapshot;
}

/** 伺服器沒開機時發布的最小快照:只有 name/generatedAt/onlineCount,不含任何圖層資料
 *  (viewer 依 onlineCount:0 顯示為離線)。刻意不呼叫 assemblePublicMapSnapshot —— 沒有任何
 *  即時資料可過濾,直接給最小形狀,不必依設定組出一堆空陣列。 */
function offlineSnapshot(serverName: string, now = Date.now()): PublicMapSnapshot {
  return {
    v: 1,
    name: serverName,
    generatedAt: now,
    onlineCount: 0,
    show: { players: false, names: false, offline: false, bases: false, guildNames: false },
  };
}

/** delay 緩衝裡挑「至少 N 分鐘前」組好的那份(取最新、但仍滿足門檻的一份)。
 *  buffer 依組裝時間(at)由舊到新排列。delayMinutes<=0 直接回傳最新一份;
 *  緩衝還沒攢夠(agent 才剛啟動 / 剛開啟發布)回傳 null,呼叫端應該跳過這輪、不送舊資料
 *  也不送太新的資料。 */
export function pickDelayedSnapshot(
  buffer: BufferedSnapshot[],
  delayMinutes: number,
  now: number,
): PublicMapSnapshot | null {
  if (buffer.length === 0) return null;
  if (delayMinutes <= 0) return buffer[buffer.length - 1].snapshot;
  const cutoff = now - delayMinutes * 60_000;
  let picked: PublicMapSnapshot | null = null;
  for (const entry of buffer) {
    if (entry.at > cutoff) break; // buffer 由舊到新,超過門檻之後的都太新
    picked = entry.snapshot;
  }
  return picked;
}

/** 「有資料但還不能送」時的替代快照 —— delayMinutes>0 但 delay 緩衝還沒攢到夠舊的版本時
 *  用(首次啟用 / rotate 當下最常見)。形狀比照 offlineSnapshot:只有
 *  v/name/generatedAt/onlineCount/show,不含 players/offline/bases,show 全部回報 false。
 *  這是 Finding A 的修法核心 —— 之前 pickDelayedSnapshot 挑不到東西時會 fallback 成剛組好
 *  的即時快照,等於繞過使用者設定的 delayMinutes,在「首次啟用」與「重生連結」當下洩漏即時
 *  位置。改成送這個之後,真正的即時快照依然照常塞進 delay 緩衝,下一輪 tick 攢夠了就會換上
 *  真正符合 delayMinutes 的版本。 */
export function minimalSnapshot(serverName: string, onlineCount: number, now: number = Date.now()): PublicMapSnapshot {
  return {
    v: 1,
    name: serverName,
    generatedAt: now,
    onlineCount,
    show: { players: false, names: false, offline: false, bases: false, guildNames: false },
  };
}

/** 決定這次真正要送出的快照:優先用 delay 緩衝挑出的版本;緩衝還沒攢夠時,delayMinutes>0
 *  就退而求其次送 minimalSnapshot(不洩漏即時位置),delayMinutes<=0(使用者本來就要即時)才
 *  直接送剛組好的這份。enable(publishNow)、rotate(publishNow)、背景 tick 三個發布路徑
 *  都呼叫這個,保證行為一致。 */
export function resolvePublishTarget(
  buffer: BufferedSnapshot[],
  settings: PublicMapSettings,
  freshSnapshot: PublicMapSnapshot,
  now: number = Date.now(),
): PublicMapSnapshot {
  const delayed = pickDelayedSnapshot(buffer, settings.delayMinutes, now);
  if (delayed) return delayed;
  return settings.delayMinutes > 0 ? minimalSnapshot(freshSnapshot.name, freshSnapshot.onlineCount, now) : freshSnapshot;
}

// ── 金鑰/ID 生成(不加依賴,純 crypto)──

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 公開分享 ID:12 碼英數,符合 ^[A-Za-z0-9_-]{8,32}$。 */
function genShareId(len = 12): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

/** 發布金鑰:32 bytes 亂數,base64url 編碼 —— 只在 agent 與 Worker 之間流動。 */
function genSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// ── 雲端推送(照 telemetry.ts / license.ts 的多端點 fallback、8 秒 timeout、失敗靜默慣例)──

async function publishToWorker(shareId: string, secret: string, snapshot: PublicMapSnapshot): Promise<boolean> {
  for (const base of STATS_URLS) {
    try {
      const res = await fetch(`${base}/api/map/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: shareId, key: secret, snapshot }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok && res.status >= 500) continue; // 這個端點壞了 -> 換下一個
      return res.ok;
    } catch {
      continue; // 連不上 -> 換下一個端點
    }
  }
  return false;
}

/** "ok" = Worker 確認下架;"gone" = Worker 說這個 id 本來就不在了(404)或已被撤銷(410)
 *  —— 對「下架」這個目的來說跟成功一樣,佇列都該移出;"failed" = 其餘一律當失敗,留在
 *  佇列等下次重試(見 Finding C 的全域下架佇列)。 */
type UnpublishOutcome = "ok" | "gone" | "failed";

async function unpublishFromWorker(shareId: string, secret: string): Promise<UnpublishOutcome> {
  for (const base of STATS_URLS) {
    try {
      const res = await fetch(`${base}/api/map/unpublish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: shareId, key: secret }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404 || res.status === 410) return "gone";
      if (res.ok) return "ok";
      if (res.status >= 500) continue; // 這個端點壞了 -> 換下一個
      return "failed";
    } catch {
      continue; // 連不上 -> 換下一個端點
    }
  }
  return "failed";
}

// ── 每實例持久化(<instanceDir>/public-map.json)──

function stateFile(store: InstanceStore, id: string): string {
  return path.join(store.instanceDir(id), "public-map.json");
}

function readState(store: InstanceStore, id: string): StoredState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(store, id), "utf8")) as Partial<StoredState>;
    return {
      settings: { ...DEFAULT_PUBLIC_MAP_SETTINGS, ...(raw.settings ?? {}) },
      secret: typeof raw.secret === "string" ? raw.secret : undefined,
    };
  } catch {
    return { settings: { ...DEFAULT_PUBLIC_MAP_SETTINGS } };
  }
}

function writeState(store: InstanceStore, id: string, state: StoredState): void {
  fs.mkdirSync(store.instanceDir(id), { recursive: true });
  fs.writeFileSync(stateFile(store, id), JSON.stringify(state, null, 2));
}

// ── 全域下架佇列(<dataDir>/public-map-unpublish-queue.json,不放在實例目錄底下 —— 見
// Finding C:實例刪除時 instanceDir 會被整個 rmSync 掉,secret 必須先搬出來才留得住)。
// disable/rotate/實例刪除時把舊 id+secret 入佇列並立即嘗試一次;之後每個 60s tick 對佇列
// 重試,成功(2xx)或已不存在/已撤銷(404/410)就移出,超過 7 天放棄移出。 ──

interface UnpublishQueueEntry {
  id: string;
  key: string;
  addedAt: number;
}

const UNPUBLISH_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function isUnpublishQueueEntry(x: unknown): x is UnpublishQueueEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.key === "string" && typeof e.addedAt === "number";
}

// ── 允許前端透過 PUT 改的欄位(shareId 不開放:只能由 enable/rotate 產生)──

const PATCHABLE_KEYS = [
  "enabled",
  "showPlayers",
  "showPlayerNames",
  "showOfflinePlayers",
  "showBases",
  "showGuildNames",
  "delayMinutes",
] as const satisfies readonly (keyof PublicMapSettings)[];

function applyPatch(base: PublicMapSettings, patch: Partial<PublicMapSettings>): PublicMapSettings {
  const next = { ...base };
  for (const key of PATCHABLE_KEYS) {
    if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key];
  }
  return next;
}

export class PublicMapPublisher {
  private timer: NodeJS.Timeout | null = null;
  private buffers = new Map<string, BufferedSnapshot[]>();
  private lastResults = new Map<string, PublicMapPublishResult>();
  /** per-instance 單調遞增世代號 —— rotate/disable/實例刪除時 +1。tick/publishNow 在組完
   *  快照、送出前會比對世代號有沒有變,變了就代表被插隊(連結已經換掉/關掉/實例被刪了),
   *  放棄這次發布,避免用舊 shareId/secret 把已撤銷的連結復活(Finding B)。 */
  private generations = new Map<string, number>();
  /** per-instance 序列化佇列 —— enable/rotate/disable/tick/PUT 設定寫入全部經過這裡排隊
   *  執行,同一實例任何時候只有一個在跑,徹底避免 public-map.json 的並行 read-modify-write
   *  互相蓋掉(Finding D),也讓上面的世代號檢查有意義。不同實例互不影響、照常平行處理。 */
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private store: InstanceStore,
    private driverFor: (rec: InstanceRecord) => ServerDriver,
    private presence: PresenceTracker,
    private dataDir: string = DATA_DIR,
    /** 授權判斷注入點(測試用;預設走真正的 license 模組)。只有背景 tick 用這個把關
     *  —— enable/rotate 已經在 routes.ts 那層擋過了,這裡是「授權期間內開啟、之後過期」
     *  這個場景的第二道防線,讓已開啟的實例授權過期後自動停止發布(設定不清、不 unpublish,
     *  等授權恢復自動續發)。 */
    private featureEnabledFn: (id: string) => boolean = featureEnabled,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 給 GET /public-map 用的完整狀態。 */
  status(rec: InstanceRecord): PublicMapStatus {
    const state = readState(this.store, rec.id);
    return {
      settings: state.settings,
      shareUrl:
        state.settings.enabled && state.settings.shareId
          ? `${PALSERVER_MAP_VIEWER}?s=${state.settings.shareId}`
          : null,
      lastPublish: this.lastResults.get(rec.id) ?? null,
    };
  }

  /** PUT /public-map:套用 patch;首次開啟(enabled false→true 且尚無 shareId)會產生
   *  shareId + secret 並立即發布一次;關閉時把舊連結送進全域下架佇列並立即嘗試一次
   *  (不擋這次儲存,失敗留給之後的 tick 重試)。 */
  async updateSettings(rec: InstanceRecord, patch: Partial<PublicMapSettings>): Promise<PublicMapStatus> {
    return this.enqueue(rec.id, async () => {
      const state = readState(this.store, rec.id);
      const wasEnabled = state.settings.enabled;
      const nextSettings = applyPatch(state.settings, patch);
      let secret = state.secret;

      if (nextSettings.enabled && !nextSettings.shareId) {
        nextSettings.shareId = genShareId();
        secret = genSecret();
      }
      writeState(this.store, rec.id, { settings: nextSettings, secret });

      if (nextSettings.enabled) {
        await this.publishNow(rec, nextSettings, secret!);
      } else if (wasEnabled && state.settings.shareId && state.secret) {
        this.bumpGeneration(rec.id); // 停用:擋掉任何插隊中的 tick 用舊連結送出
        this.retireShareId(state.settings.shareId, state.secret);
      }
      return this.status(rec);
    });
  }

  /** POST /public-map/rotate:舊 shareId 下架、換一組新的 shareId+secret 並立即發布。 */
  async rotate(rec: InstanceRecord): Promise<PublicMapStatus> {
    return this.enqueue(rec.id, async () => {
      const state = readState(this.store, rec.id);
      this.bumpGeneration(rec.id); // 換碼:擋掉任何插隊中的 tick 用舊連結送出
      if (state.settings.shareId && state.secret) {
        this.retireShareId(state.settings.shareId, state.secret);
      }
      const nextSettings: PublicMapSettings = { ...state.settings, shareId: genShareId() };
      const secret = genSecret();
      writeState(this.store, rec.id, { settings: nextSettings, secret });
      this.buffers.delete(rec.id); // 換碼視同新的一份地圖,不沿用舊 delay 緩衝

      if (nextSettings.enabled) {
        await this.publishNow(rec, nextSettings, secret);
      }
      return this.status(rec);
    });
  }

  /** 實例被刪除前的清理鉤子:實例目錄(含 public-map.json,secret 唯一的存放處)即將被
   *  整個 rmSync 掉,secret 必須在那之前讀出來搬進全域下架佇列,Worker 上的快照才有機會
   *  被撤銷(Finding C)。呼叫端(routes.ts DELETE /api/instances/:id)必須在 rmSync **之前**
   *  await 這個方法。 */
  async instanceRemoved(id: string): Promise<void> {
    await this.enqueue(id, async () => {
      this.bumpGeneration(id); // 擋掉任何插隊中的 tick
      const state = readState(this.store, id);
      if (state.settings.shareId && state.secret) {
        this.retireShareId(state.settings.shareId, state.secret);
      }
    });
    this.buffers.delete(id);
    this.lastResults.delete(id);
    this.generations.delete(id);
    this.chains.delete(id);
  }

  private generationOf(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  private bumpGeneration(id: string): void {
    this.generations.set(id, this.generationOf(id) + 1);
  }

  /** 同一實例的操作排隊執行(FIFO),避免並行 read-modify-write 互相蓋掉。前一個任務失敗
   *  不會卡住隊列 —— 佇列本身追蹤的是「settle 了沒」,不是「成功了沒」;呼叫端拿到的
   *  回傳值仍然是這次 fn 真正的結果(成功或失敗)。 */
  private enqueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const run = prev.then(fn);
    this.chains.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** 舊連結下架:入全域佇列(持久化,實例目錄砍掉也不受影響)並立即嘗試一次;成功或
   *  Worker 說已經不在了(404/410)就直接從佇列移出,失敗留給之後的 60s tick 重試。 */
  private retireShareId(shareId: string, secret: string): void {
    this.enqueueUnpublish(shareId, secret);
    void unpublishFromWorker(shareId, secret)
      .then((outcome) => {
        if (outcome === "ok" || outcome === "gone") this.removeFromUnpublishQueue(shareId, secret);
      })
      .catch(() => {});
  }

  private unpublishQueueFile(): string {
    return path.join(this.dataDir, "public-map-unpublish-queue.json");
  }

  private readUnpublishQueue(): UnpublishQueueEntry[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.unpublishQueueFile(), "utf8"));
      return Array.isArray(raw) ? raw.filter(isUnpublishQueueEntry) : [];
    } catch {
      return [];
    }
  }

  private writeUnpublishQueue(entries: UnpublishQueueEntry[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.unpublishQueueFile(), JSON.stringify(entries, null, 2));
  }

  /** 同步 read-modify-write(讀、改、寫之間沒有 await),跟 retryUnpublishQueue 之間不會
   *  交錯執行 —— Node 單執行緒,只要中間不 yield 就不必額外加鎖。 */
  private enqueueUnpublish(shareId: string, secret: string): void {
    const queue = this.readUnpublishQueue();
    if (queue.some((e) => e.id === shareId && e.key === secret)) return; // 已經在佇列裡
    queue.push({ id: shareId, key: secret, addedAt: Date.now() });
    this.writeUnpublishQueue(queue);
  }

  private removeFromUnpublishQueue(shareId: string, secret: string): void {
    const queue = this.readUnpublishQueue();
    const next = queue.filter((e) => !(e.id === shareId && e.key === secret));
    if (next.length !== queue.length) this.writeUnpublishQueue(next);
  }

  /** 背景每分鐘一次(搭 tick 的 60s 間隔):對下架佇列裡每一筆重試。成功或 Worker 說已經
   *  不在了(404/410)就移出;超過 7 天(UNPUBLISH_QUEUE_MAX_AGE_MS)放棄、直接移出,避免
   *  佇列無限累積早就沒人管的舊連結。 */
  private async retryUnpublishQueue(): Promise<void> {
    try {
      const queue = this.readUnpublishQueue();
      if (queue.length === 0) return;
      const now = Date.now();
      const remaining: UnpublishQueueEntry[] = [];
      for (const entry of queue) {
        if (now - entry.addedAt > UNPUBLISH_QUEUE_MAX_AGE_MS) continue; // 超過 7 天,放棄
        const outcome = await unpublishFromWorker(entry.id, entry.key);
        if (outcome === "ok" || outcome === "gone") continue; // 成功或已撤銷,移出佇列
        remaining.push(entry);
      }
      if (remaining.length !== queue.length) this.writeUnpublishQueue(remaining);
    } catch {
      // 佇列檔案讀寫失敗(權限/磁碟滿):靜默放棄這輪,下次 tick 再試。
    }
  }

  /** 背景每分鐘一次:對每個已啟用的實例組快照、推進 delay 緩衝、送出;同時重試全域
   *  下架佇列。每個實例的工作都經過 enqueue 排隊,避免跟同一實例的 rotate/disable/PUT
   *  並行搶跑(Finding B / D)。 */
  private async tick(): Promise<void> {
    await this.retryUnpublishQueue();
    for (const rec of this.store.list()) {
      const state = readState(this.store, rec.id);
      if (!state.settings.enabled || !state.settings.shareId || !state.secret) continue;
      const shareId = state.settings.shareId;
      const secret = state.secret;
      await this.enqueue(rec.id, () => this.tickOne(rec, shareId, secret));
    }
  }

  private async tickOne(rec: InstanceRecord, shareId: string, secret: string): Promise<void> {
    const generation = this.generationOf(rec.id);
    try {
      // 排到我們才真的執行:重新讀一次狀態,若已經被 disable/rotate 搶先關掉/換掉,放棄。
      const fresh = readState(this.store, rec.id);
      if (!fresh.settings.enabled || fresh.settings.shareId !== shareId || fresh.secret !== secret) return;
      // 授權過期:跳過這輪發布,不動設定也不 unpublish —— 等授權恢復,下個 tick 自動續發。
      if (!this.featureEnabledFn("public-map")) return;

      const snapshot = await this.assemble(rec, fresh.settings);
      if (this.generationOf(rec.id) !== generation) return; // assemble 期間被插隊,放棄這次發布
      this.pushBuffer(rec.id, snapshot);
      const toSend = resolvePublishTarget(this.buffers.get(rec.id) ?? [], fresh.settings, snapshot);

      if (this.generationOf(rec.id) !== generation) return; // 送出前再確認一次
      const ok = await publishToWorker(shareId, secret, toSend);
      this.lastResults.set(rec.id, {
        at: Date.now(),
        ok,
        error: ok ? undefined : "推送失敗:所有雲端端點都連不上或回應錯誤",
      });
    } catch (err) {
      this.lastResults.set(rec.id, {
        at: Date.now(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 立即發布一次(啟用當下 / rotate 當下用)。呼叫端(updateSettings/rotate)已經透過
   *  enqueue 排隊,這裡的世代號檢查是防禦性的第二道防線。 */
  private async publishNow(rec: InstanceRecord, settings: PublicMapSettings, secret: string): Promise<void> {
    // 與 tickOne 同一道 gate:授權失效時任何發布路徑都不得推送(否則設定 PUT 觸發的
    // 即時發布會變成繞過 tick gate 的後門);unpublish 不在此限。
    if (!this.featureEnabledFn("public-map")) return;
    const generation = this.generationOf(rec.id);
    try {
      const snapshot = await this.assemble(rec, settings);
      if (this.generationOf(rec.id) !== generation) return; // assemble 期間被插隊,放棄這次發布
      this.pushBuffer(rec.id, snapshot);
      const toSend = resolvePublishTarget(this.buffers.get(rec.id) ?? [], settings, snapshot);
      const ok = await publishToWorker(settings.shareId!, secret, toSend);
      this.lastResults.set(rec.id, {
        at: Date.now(),
        ok,
        error: ok ? undefined : "推送失敗:所有雲端端點都連不上或回應錯誤",
      });
    } catch (err) {
      this.lastResults.set(rec.id, {
        at: Date.now(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private pushBuffer(id: string, snapshot: PublicMapSnapshot): void {
    const buf = this.buffers.get(id) ?? [];
    buf.push({ at: Date.now(), snapshot });
    const cutoff = Date.now() - BUFFER_MAX_AGE_MS;
    while (buf.length && buf[0].at < cutoff) buf.shift();
    this.buffers.set(id, buf);
  }

  /** 組一份完整過濾後的快照。伺服器沒在運作中時回傳最小快照(onlineCount:0),
   *  不去打 REST API。PalDefender 沒裝/連不上時省略對應圖層,不丟例外中斷發布。 */
  private async assemble(rec: InstanceRecord, settings: PublicMapSettings): Promise<PublicMapSnapshot> {
    const guildNamesUnlocked = featureEnabled("guild-map");
    const serverName = String(rec.settings.ServerName || rec.name);
    const ctx: DriverContext = { instanceDir: this.store.instanceDir(rec.id) };

    const { status } = await this.driverFor(rec).status(rec, ctx);
    if (status !== "running") {
      return offlineSnapshot(serverName);
    }

    const live = await getLiveStatus(rec);
    const onlineCount = live.available ? live.players.length : 0;
    const maxPlayers = live.metrics?.maxplayernum;
    const online: PublicMapRawPlayer[] = live.available
      ? live.players.map((p) => ({ userId: p.userId, name: p.name, level: p.level, savX: p.location_x, savY: p.location_y }))
      : [];

    let offline: PublicMapRawPlayer[] = [];
    if (settings.showOfflinePlayers) {
      const pd = await getPdPlayers(rec, ctx).catch(() => null);
      if (pd?.available) {
        const known = new Map(this.presence.knownPlayers(rec.id).map((k) => [k.userId, k]));
        offline = pd.players
          .filter((p) => !p.online && p.worldX != null && p.worldY != null)
          .map((p) => ({
            userId: p.userId,
            name: p.name,
            level: known.get(p.userId)?.lastLevel ?? 0,
            savX: p.worldX!,
            savY: p.worldY!,
          }));
      }
    }

    let bases: PublicMapRawBase[] = [];
    if (settings.showBases) {
      // 公開地圖本身開關是贊助者先行版(public-map,見 tickOne 的 gate),但「開啟之後
      // 顯示哪些圖層」這件事裡,據點「位置」一律免費,公會「名稱」才另外是贊助者
      // 先行版功能(guild-map)。所以這裡永遠用 detailed=true 拿完整據點資料,名稱是否
      // 附上由 assemblePublicMapSnapshot 依 guildNamesUnlocked 自己過濾,而不是靠
      // getPdGuilds 的 detailed 旗標(那個旗標是全有全無,會連位置都拿不到)。
      const pdg = await getPdGuilds(rec, ctx, true).catch(() => null);
      if (pdg?.available) {
        bases = pdg.guilds.flatMap((g) => g.bases.map((b) => ({ worldX: b.worldX, worldY: b.worldY, guildName: g.name })));
      }
    }

    return assemblePublicMapSnapshot({ serverName, onlineCount, maxPlayers, online, offline, bases }, settings, guildNamesUnlocked);
  }
}
