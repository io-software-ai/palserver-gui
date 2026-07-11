#!/usr/bin/env node
/**
 * palserver 贊助者授權 / Buy Me a Coffee webhook 管理 CLI。
 *
 * 「BMC 後台新增 webhook」要在 dashboard 手動做(BMC 沒有建 webhook 的公開 API)。
 * 這支腳本負責其餘可自動化的部分:驗整條 webhook 流程、手動發碼、解綁換機。
 *
 * 用法:
 *   node manage.mjs test-webhook [event] [email]   送一個「簽好章」的假 BMC webhook 到 worker,
 *                                                   驗證簽章、發碼(會實際寄信,除非 email 省略)。
 *                                                   event 預設 membership.started
 *   node manage.mjs issue [sponsor] [expiresAt]     手動發一張碼(expiresAt=月費到期,ISO 或 yyyy-mm-dd)
 *   node manage.mjs reset  <code>                    解除某張碼的機器綁定(讓贊助者換機)
 *
 * 環境變數(可寫在 shell 或 packages/stats/.env,別 commit):
 *   WORKER_URL           預設 https://palserver-stats.iosoftware.workers.dev
 *   ADMIN_TOKEN          issue / reset 用(= worker 上設的 ADMIN_TOKEN)
 *   BMC_WEBHOOK_SECRET   test-webhook 簽章用(= worker 上設的 BMC_WEBHOOK_SECRET)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 極簡 .env 載入(同目錄的 .env;不覆蓋已存在的環境變數)。
const here = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(here, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* 沒有 .env 就算了 */
}

const WORKER_URL = (process.env.WORKER_URL ?? "https://palserver-stats.iosoftware.workers.dev").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const BMC_WEBHOOK_SECRET = process.env.BMC_WEBHOOK_SECRET ?? "";

const die = (msg) => {
  console.error("✗ " + msg);
  process.exit(1);
};
const pretty = (r) => JSON.stringify(r, null, 2);

async function testWebhook(event = "membership.started", email = "tester@example.com") {
  if (!BMC_WEBHOOK_SECRET) die("需要 BMC_WEBHOOK_SECRET(要跟 worker 上設的一致)才能簽章。");
  const payload = {
    event_id: "evt_test_" + Date.now(),
    type: event,
    live_mode: false,
    created: new Date().toISOString(),
    attempt: 1,
    data: { supporter_email: email, membership_level_name: "先行版贊助" },
  };
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", BMC_WEBHOOK_SECRET).update(raw).digest("hex");
  console.log(`→ POST ${WORKER_URL}/api/license/bmc-webhook  (${event}, ${email})`);
  const res = await fetch(`${WORKER_URL}/api/license/bmc-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-signature-sha256": sig },
    body: raw,
  });
  const body = await res.json().catch(() => ({}));
  console.log(`← HTTP ${res.status}\n${pretty(body)}`);
  if (res.ok && body.action) console.log(`\n✓ 流程通了(action=${body.action})。真實會員時 worker 會照樣發碼/寄信。`);
}

async function issue(sponsor, expiresAt) {
  if (!ADMIN_TOKEN) die("需要 ADMIN_TOKEN(= worker 上設的)才能發碼。");
  // 允許只給日期(yyyy-mm-dd)-> 補成當天 UTC 結束。
  const exp = expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt) ? `${expiresAt}T23:59:59Z` : expiresAt || null;
  const res = await fetch(`${WORKER_URL}/api/license/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN },
    body: JSON.stringify({ sponsor: sponsor || null, expiresAt: exp }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(`HTTP ${res.status}: ${pretty(body)}`);
  console.log(`✓ 已發碼:${body.code}`);
  console.log(pretty(body));
}

async function reset(code) {
  if (!ADMIN_TOKEN) die("需要 ADMIN_TOKEN。");
  if (!code) die("用法:node manage.mjs reset <code>");
  const res = await fetch(`${WORKER_URL}/api/license/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(`HTTP ${res.status}: ${pretty(body)}`);
  console.log(body.reset ? `✓ 已解除綁定:${code}(該贊助者可換機重新啟用)` : `⚠ 找不到這張碼:${code}`);
}

// 忽略 pnpm/npm 有時會原樣傳進來的 "--" 分隔符。
const [cmd, ...args] = process.argv.slice(2).filter((a) => a !== "--");
const run = {
  "test-webhook": () => testWebhook(args[0], args[1]),
  issue: () => issue(args[0], args[1]),
  reset: () => reset(args[0]),
};
if (!run[cmd]) {
  console.log(
    [
      "palserver 授權 / BMC webhook 管理",
      "",
      "  node manage.mjs test-webhook [event] [email]   驗證整條 webhook(簽章→發碼→寄信)",
      "  node manage.mjs issue [sponsor] [expiresAt]     手動發一張碼(月費填到期日)",
      "  node manage.mjs reset <code>                     解除機器綁定,讓贊助者換機",
      "",
      "  需要的環境變數:WORKER_URL / ADMIN_TOKEN / BMC_WEBHOOK_SECRET(見檔頭)",
    ].join("\n"),
  );
  process.exit(cmd ? 1 : 0);
}
await run[cmd]();
