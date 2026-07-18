# @palserver/stats — 匿名使用統計後端

Cloudflare Worker + D1,收集 palserver GUI 的匿名使用統計(隱私原則見根目錄
[PRIVACY.md](../../PRIVACY.md)),並彙總 GitHub Releases 下載數。

## 端點

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `POST` | `/api/event` | agent 回報事件:`hello`(啟動)、`instance_created`、`server_started`、`players_seen`(玩家雜湊批次) |
| `GET` | `/api/stats` | 公開彙總:`downloads` / `admins` / `players` / `instancesCreated` / `serverStarts` |
| `POST` | `/api/map/publish` | agent 每 60 秒推送地圖快照,見下方「公開地圖快照」 |
| `GET` | `/api/map/snapshot` | 公開讀取地圖快照(viewer 頁用) |
| `POST` | `/api/map/unpublish` | 服主下架地圖快照 |

## 部署(一次性)

```bash
cd packages/stats
npx wrangler login                        # 登入 Cloudflare 帳號
npx wrangler d1 create palserver-stats    # 建 D1,把回傳的 database_id 填進 wrangler.toml
pnpm db:schema                            # 建表(schema.sql)
pnpm deploy                               # 部署 worker
```

部署完成會得到 `https://palserver-stats.<你的帳號>.workers.dev`(也可在
Cloudflare 後台綁自訂網域)。**把這個網址更新到兩個地方:**

1. `packages/agent/src/env.ts` 的 `STATS_URL` 預設值
2. `packages/web/src/stats.ts` 的 `STATS_URL`

agent 端也可用環境變數 `PALSERVER_STATS_URL` 覆寫,不改码就能切換端點。

## GitHub 下載數抓不到(downloads: null)?

GitHub API 對匿名請求限流,Cloudflare Workers 的共用出口 IP 很容易踩到。
放一個唯讀 token 即可穩定:

```bash
npx wrangler secret put GITHUB_TOKEN   # 貼上 fine-grained PAT(只需 public repo 唯讀)
```

## 公開地圖快照

服主一鍵把伺服器地圖公開到全網:agent 每 60 秒把過濾後的地圖快照 JSON 推上來,
公開 viewer 頁(官網靜態頁)用 `id`(shareId)讀取。`id` 首次出現即註冊,綁定當下傳入的
`key`(只存 SHA-256 雜湊,不存明碼);之後同一個 `id` 要覆寫或下架都須帶對的 `key`。

- `POST /api/map/publish {id, key, snapshot}` — 註冊/更新快照;伺服器對伺服器端點(agent 直連),
  無 CORS(不帶 `Access-Control-Allow-Origin`)。`id` 需符合 `^[A-Za-z0-9_-]{8,32}$`;`snapshot`
  序列化後不得超過 128 KiB(413);同一 `id` 連續推送間隔須 ≥ 10 秒,否則 429;`key` 不符回
  401 `{error:"bad-key"}`。**新** `id`(第一次出現)另外受兩道防灌爆檢查:同一來源 IP(取
  `CF-Connecting-IP` 做 SHA-256,查不到當 `"unknown"`)24 小時內最多註冊 10 個新 id,超過回
  429 `{error:"rate-limited"}`;全站快照數 ≥ 50000 時回 503 `{error:"capacity"}`。新註冊路徑
  會順手清掉 48 小時前的節流紀錄,以及 60 天未更新(含已下架)的快照列。
- `GET /api/map/snapshot?id=...` — 公開讀取,`{updatedAt, snapshot}`,開放 CORS(`*`,含 OPTIONS
  preflight)、`Cache-Control: public, max-age=15`;找不到或已下架回 404。
- `POST /api/map/unpublish {id, key}` — 服主下架(伺服器對伺服器,無 CORS);`key` 不符 401,
  `id` 不存在 404。下架是「墓碑」(`revoked=1` + 清空 snapshot),不是刪列——之後任何人拿舊
  `key` 對同一個 `id` 重新 `publish` 一律回 410 `{error:"revoked"}`,不會被當成新 id 復活。

## 贊助者識別碼(先行版授權)

同一個 worker 也負責發/驗贊助者識別碼(一機一碼)。端點:

- `POST /api/license/activate {code, machineId}` — agent 用,驗證 + 首次綁機器(公開)
- `POST /api/license/issue {count?, trialDays?, expiresAt?, sponsor?, features?}` — 發碼(需 `X-Admin-Token`);`count` 可一次多張,`trialDays` = 啟用後 N 天(試用碼,兌換當下才起算到期)
- `POST /api/license/list {filter?, limit?}` — 列出識別碼(需 `X-Admin-Token`)
- `POST /api/license/reset {code}` — 解除綁定讓贊助者換機(需 `X-Admin-Token`)
- `POST /api/license/delete {code}` — 撤銷(刪除)一張碼(需 `X-Admin-Token`)
- `POST /api/license/bmc-webhook` — Buy Me a Coffee 月費會員 webhook(自動發碼/續期;信件依 BMC 語言中英日,fallback 英文)

### 管理後台 UI

`GET /admin`(例:`https://palserver-stats.iosoftware.workers.dev/admin`)是一個發碼/管理的網頁介面:
輸入 `ADMIN_TOKEN` 後可**大量發試用碼**(數量、啟用後 N 天 / 固定到期 / 永久、活動標籤)、
複製 / 下載 CSV,並在表格裡檢視、解綁、撤銷。頁面公開但所有操作都要 Token,Token 只存在該分頁。

> 新增 `trial_days` 欄位:舊 DB 需 `ALTER TABLE licenses ADD COLUMN trial_days INTEGER;`(見 schema.sql)。

```bash
# 管理密鑰(發碼/解綁用)
npx wrangler secret put ADMIN_TOKEN

# 手動發一張碼(帶 expiresAt 即為月費;到期後 agent 重驗會鎖上)
curl -X POST https://palserver-stats.iosoftware.workers.dev/api/license/issue \
  -H "X-Admin-Token: <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"sponsor":"某人","expiresAt":"2026-09-01"}'
```

### 接 Buy Me a Coffee 月費

1. BMC 開一個月費 **Membership** 方案。
2. BMC 後台 → Webhooks 新增,URL 填 `https://<worker>/api/license/bmc-webhook`,複製**簽章密鑰**。
3. 設密鑰;Brevo(app.brevo.com)用來把碼 email 給贊助者(需先在 Brevo 驗證寄件者/網域):

   ```bash
   npx wrangler secret put BMC_WEBHOOK_SECRET   # BMC 給的 webhook secret
   npx wrangler secret put BREVO_API_KEY        # Brevo API key(SMTP & API → API Keys）
   # 寄件者可用環境變數覆寫(預設 palserver GUI <palserver-gui@iosoftware.ai>),例:
   #   [vars] BREVO_FROM_EMAIL = "palserver-gui@iosoftware.ai"
   #   [vars] BREVO_FROM_NAME  = "palserver GUI"
   ```

流程:會員 `membership.started` → 建碼並 email 給贊助者;`membership.updated`(續訂)→ 延長效期;
`cancelled` / `paused` → 不再續期,當期到期後停用。webhook 會先用 `x-signature-sha256`
(HMAC-SHA256)驗簽,沒設 `BMC_WEBHOOK_SECRET` 一律拒絕。

### 管理 CLI(`manage.mjs`)

BMC 後台那個「新增 webhook」要手動做(BMC 沒有建 webhook 的 API),其餘可用這支腳本:

```bash
# 環境變數放 packages/stats/.env(已被 gitignore):
#   WORKER_URL / ADMIN_TOKEN / BMC_WEBHOOK_SECRET
pnpm license:test  -- membership.started you@example.com   # 送簽好章的假 webhook,驗整條線
pnpm license:issue -- "某贊助者" 2026-09-01                # 手動發一張碼(月費填到期日)
pnpm license:reset -- PAL-XXXX-XXXX-XXXX                    # 解綁,讓贊助者換機
```

## 之後改 schema / 重新部署

```bash
pnpm db:schema   # schema.sql 全部是 IF NOT EXISTS,可重複執行
pnpm deploy
```

> 若 `licenses` 表已建過,加 email/source 兩欄要手動 ALTER(見 schema.sql 內註解)。
