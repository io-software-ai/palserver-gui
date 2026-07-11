# @palserver/stats — 匿名使用統計後端

Cloudflare Worker + D1,收集 palserver GUI 的匿名使用統計(隱私原則見根目錄
[PRIVACY.md](../../PRIVACY.md)),並彙總 GitHub Releases 下載數。

## 端點

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `POST` | `/api/event` | agent 回報事件:`hello`(啟動)、`instance_created`、`server_started`、`players_seen`(玩家雜湊批次) |
| `GET` | `/api/stats` | 公開彙總:`downloads` / `admins` / `players` / `instancesCreated` / `serverStarts` |

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

## 贊助者識別碼(先行版授權)

同一個 worker 也負責發/驗贊助者識別碼(一機一碼)。端點:

- `POST /api/license/activate {code, machineId}` — agent 用,驗證 + 首次綁機器(公開)
- `POST /api/license/issue {tier?, features?, sponsor?, expiresAt?}` — 手動發碼(需 `X-Admin-Token`)
- `POST /api/license/reset {code}` — 解除綁定讓贊助者換機(需 `X-Admin-Token`)
- `POST /api/license/bmc-webhook` — Buy Me a Coffee 月費會員 webhook(自動發碼/續期)

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
3. 設密鑰;Resend 用來把碼 email 給贊助者(需先在 Resend 驗證寄件網域):

   ```bash
   npx wrangler secret put BMC_WEBHOOK_SECRET   # BMC 給的 webhook secret
   npx wrangler secret put RESEND_API_KEY       # Resend API key
   # 寄件者放 vars 或 secret 皆可,例:
   #   [vars] RESEND_FROM = "palserver GUI <noreply@你的網域>"
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
