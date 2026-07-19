import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { InstanceStore } from "./store.js";
import { WebhooksService, signBody } from "./webhooks.js";
import type { AgentEvent } from "./events.js";

const INST = "inst1";

/** 用暫存目錄當 instanceDir 的最小 InstanceStore。 */
function fakeStore(): { store: InstanceStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-test-"));
  const store = {
    instanceDir: (id: string) => path.join(dir, id),
    get: (id: string) => (id === INST ? ({ id, name: "測試伺服器" } as never) : undefined),
    list: () => [{ id: INST } as never],
  } as unknown as InstanceStore;
  return { store, dir };
}

/** 本地接收器:記錄每個進來的請求,回覆指定狀態碼。 */
function receiver(status = 200): Promise<{
  url: string;
  requests: { headers: http.IncomingHttpHeaders; body: string }[];
  close: () => void;
}> {
  const requests: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body });
      res.writeHead(status);
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

const chatEvent = (): AgentEvent => ({
  type: "player.chat",
  instanceId: INST,
  occurredAt: "2026-07-20T10:00:00.000Z",
  data: { name: "Alice", channel: "Global", message: "hello" },
});

test("generic:送出帶有效 HMAC 簽章 + 正確 header/body", async () => {
  const { store } = fakeStore();
  const rx = await receiver(200);
  const svc = new WebhooksService(store, "test", () => true);
  const { secret } = await svc.create(INST, { url: rx.url, events: ["player.chat"], format: "generic" });

  await svc.dispatchEvent(chatEvent());
  rx.close();

  assert.equal(rx.requests.length, 1);
  const req = rx.requests[0];
  assert.equal(req.headers["x-palserver-event"], "player.chat");
  assert.ok(req.headers["x-palserver-delivery"]);
  const ts = req.headers["x-palserver-timestamp"] as string;
  const sig = req.headers["x-palserver-signature"] as string;
  assert.equal(sig, `sha256=${signBody(secret, ts, req.body)}`); // 簽章可被 secret 重算驗證
  const env = JSON.parse(req.body);
  assert.equal(env.type, "player.chat");
  assert.equal(env.specVersion, "1.0");
  assert.equal(env.data.message, "hello");
  assert.equal(env.instance.name, "測試伺服器");
});

test("discord:送 embed、不帶簽章 header", async () => {
  const { store } = fakeStore();
  const rx = await receiver(200);
  const svc = new WebhooksService(store, "test", () => true);
  await svc.create(INST, { url: rx.url, events: ["*"], format: "discord" });

  await svc.dispatchEvent(chatEvent());
  rx.close();

  assert.equal(rx.requests.length, 1);
  assert.equal(rx.requests[0].headers["x-palserver-signature"], undefined);
  const payload = JSON.parse(rx.requests[0].body);
  assert.ok(Array.isArray(payload.embeds));
  assert.equal(payload.embeds[0].title, "聊天");
});

test("未授權:featureEnabled=false → 完全不送出", async () => {
  const { store } = fakeStore();
  const rx = await receiver(200);
  const svc = new WebhooksService(store, "test", () => false);
  await new WebhooksService(store, "test", () => true).create(INST, {
    url: rx.url,
    events: ["*"],
    format: "generic",
  });

  await svc.dispatchEvent(chatEvent());
  rx.close();
  assert.equal(rx.requests.length, 0);
});

test("失敗(500):記為失敗並進重試佇列", async () => {
  const { store, dir } = fakeStore();
  const rx = await receiver(500);
  const svc = new WebhooksService(store, "test", () => true);
  const { config } = await svc.create(INST, { url: rx.url, events: ["player.chat"], format: "generic" });

  await svc.dispatchEvent(chatEvent());
  rx.close();

  assert.equal(rx.requests.length, 1); // 有嘗試送
  const del = svc.deliveries(INST, config.id);
  assert.equal(del.length, 1);
  assert.equal(del[0].ok, false);
  assert.equal(del[0].status, 500);
  // 進了重試佇列
  const rt = JSON.parse(fs.readFileSync(path.join(dir, INST, "webhook-runtime.json"), "utf8"));
  assert.equal(rt.queue.length, 1);
  assert.equal(rt.queue[0].webhookId, config.id);
});

test("訂閱不符的事件不觸發;list 隱藏 secret 只回 secretSet", async () => {
  const { store } = fakeStore();
  const rx = await receiver(200);
  const svc = new WebhooksService(store, "test", () => true);
  await svc.create(INST, { url: rx.url, events: ["server.crash"], format: "generic" });

  await svc.dispatchEvent(chatEvent()); // player.chat 不在訂閱內
  rx.close();
  assert.equal(rx.requests.length, 0);

  const listed = svc.list(INST);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].secretSet, true);
  assert.equal((listed[0] as unknown as Record<string, unknown>).secret, undefined);
});
