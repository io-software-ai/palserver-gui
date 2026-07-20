# Webhook 開發者指南

palserver-GUI 的 agent 會在伺服器事件發生時,對你設定的 URL 發出**簽章過的 JSON POST**。
你可以用它接自己的 Discord 機器人、通知服務、資料收集,或任何 HTTP 端點。

> **贊助限定**:webhook 為贊助者功能。要啟用需在 GUI 設定頁填入贊助者識別碼。

---

## 快速開始

1. 在 GUI 開啟某伺服器的 **Webhook** 分頁(在「設定 → 顯示的分頁」開啟該分頁)。
2. 新增一個 webhook:填**接收 URL**、勾選要訂閱的**事件**、選**格式**:
   - `generic` — 收到帶 HMAC 簽章的事件信封(自建服務 / 機器人用,見下)。
   - `discord` — agent 直接把事件轉成 Discord embed,**URL 填 Discord 頻道的 Incoming Webhook 網址**即可,不需要寫任何程式、不驗簽。
3. 建立後會顯示一次 **secret**(用來驗簽),請立刻複製保存 —— 之後只能換發、無法再查看。

---

## 事件信封

所有 `generic` 事件的 body 都是這個外層結構:

```json
{
  "id": "evt_5f3a...c1",
  "type": "player.join",
  "specVersion": "1.0",
  "instance": { "id": "abc123", "name": "我的伺服器" },
  "occurredAt": "2026-07-20T10:00:00.000Z",
  "data": { }
}
```

| 欄位 | 說明 |
|---|---|
| `id` | 這次投遞的唯一 id,同時放在 `X-Palserver-Delivery` header。**拿來去重**(見「投遞語意」)。 |
| `type` | 事件型別(見下方目錄)。 |
| `specVersion` | 合約版本。破壞性改動才升 major;新增欄位 / 事件型別不升。請「多的欄位容忍、缺的欄位給預設」。 |
| `instance` | 來源伺服器實例的 `id` 與顯示名稱。 |
| `occurredAt` | 事件發生時間(ISO8601)。 |
| `data` | 依 `type` 而定的資料(見下)。 |

---

## 事件目錄

命名為 `namespace.action`。訂閱時可用萬用字元:`player.*`(整個命名空間)、`*`(全部)。

### player.*
| type | data | 備註 |
|---|---|---|
| `player.join` | `{ userId, name, level?, ping? }` | |
| `player.leave` | `{ userId, name }` | |
| `player.chat` | `{ name, channel, message }` | 需伺服器日誌可解析(裝 PalDefender 最完整) |
| `player.death` | `{ name, cause, pal? }` | 野生帕魯擊殺時帶 `pal` |
| `player.capture` | `{ name, pal }` | |

### server.*
| type | data |
|---|---|
| `server.starting` | `{}` |
| `server.running` | `{ version? }` |
| `server.exited` | `{ code? }` |
| `server.crash` | `{ detail? }` |
| `server.restart` | `{ reason, ok, detail? }`（reason:scheduled / memory / crash / manual / startup-failure） |
| `server.startup_failure` | `{ detail? }` |
| `server.update_available` | `{ current, latest }` |

### boss.* / backup.*
| type | data | 備註 |
|---|---|---|
| `boss.killed` | `{ bossId, name? }` | 需安裝頭目回報 mod（UE4SS） |
| `boss.respawn` | `{ bossId, name? }` | 同上 |
| `backup.completed` | `{ path?, sizeBytes? }` | |
| `backup.failed` | `{ error }` | |

### webhook.ping
按「測試」按鈕送出的測試事件,`data` 為 `{}`。

> **事件是否收得到取決於環境**:chat / death / capture 需伺服器日誌能被解析(PalDefender 最全,原生 console 較少);boss.* 需裝頭目回報 mod。訂閱了不代表一定會收到。

---

## HTTP 投遞與簽章(generic)

每次投遞是一個 `POST`,header 如下:

```
POST <你的 URL>
Content-Type: application/json
User-Agent: palserver-agent/<版本>
X-Palserver-Event: player.join
X-Palserver-Delivery: evt_5f3a...c1        # 唯一投遞 id,用來去重
X-Palserver-Timestamp: 1721469600           # unix 秒
X-Palserver-Signature: sha256=<hex>         # 見下方簽章演算法
```

**簽章演算法**:

```
signature = HMAC-SHA256(secret, `${X-Palserver-Timestamp}.${rawBody}`)   // 輸出 hex
```

也就是:把 timestamp(header 原字串)、一個點 `.`、以及**原始 request body 字串**串接後,用你的 secret 做 HMAC-SHA256,取 hex,與 `X-Palserver-Signature` 去掉 `sha256=` 前綴的部分比較。

驗證時請:
1. 用**原始 body bytes** 重算(不要先 JSON.parse 再 stringify —— 會改變字串)。
2. 用**定時比較**(timing-safe)避免時序側漏。
3. **拒絕** `X-Palserver-Timestamp` 與現在相差超過 ±5 分鐘的請求(防重放)。

### 驗簽範例 — Node.js

```js
import crypto from "node:crypto";

// rawBody = 收到的原始請求字串(Express: express.raw({type:"application/json"}))
function verify(rawBody, headers, secret) {
  const ts = headers["x-palserver-timestamp"];
  const sig = headers["x-palserver-signature"] || "";
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // ±5 分鐘
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

### 驗簽範例 — Python

```python
import hashlib, hmac, time

def verify(raw_body: bytes, headers, secret: str) -> bool:
    ts = headers.get("X-Palserver-Timestamp", "")
    sig = headers.get("X-Palserver-Signature", "")
    if abs(time.time() - float(ts or 0)) > 300:  # ±5 分鐘
        return False
    expected = "sha256=" + hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)
```

---

## 投遞語意

- **至少一次(at-least-once)**:送失敗會重試(指數退避,約 30s → 2h,最多數次或 24 小時後放棄)。
  同一事件**可能重送**,請用 `X-Palserver-Delivery` 去重(冪等處理)。
- **請在 8 秒內回 2xx**。逾時或非 2xx 都視為失敗、會進重試佇列。
- **順序不保證**:重試會打亂順序,請依 `occurredAt` 判斷先後。

---

## Discord 直送(format: discord)

把 webhook 格式設為 `discord`、URL 填 Discord 頻道的 **Incoming Webhook** 網址,agent 會自動把事件轉成 embed 送出(**不簽章** —— Discord Incoming Webhook 不驗簽)。適合只想要通知、不想寫程式的情境。想要更進階的路由 / 指令,用 `generic` 接自己的機器人。

---

## 從 Discord / 你的機器人回控伺服器(指令方向)

事件是「伺服器 → 外」。反方向(「Discord 指令 → 伺服器」,例如 `/players`、`/broadcast`、`/restart`)是用 **agent 既有的 REST API** 完成 —— 你的機器人帶 agent 的 token 直接呼叫。官方 Discord bot(規劃中,將放在 `packages/discord-bot`)會是這條路徑的參考實作。agent REST API 的端點與 token 用法見主文件。

---

## 版本政策

`specVersion` 目前為 `1.0`。新增欄位或事件型別**不會**升 major;只有破壞既有欄位語意才會。請把消費端寫成向前相容(容忍未知欄位、對缺欄位給預設)。
