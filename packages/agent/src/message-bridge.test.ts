import assert from "node:assert/strict";
import test from "node:test";
import { localizePalName } from "@palserver/shared";
import { buildAdminGrantCommand, formatGameEvent, normalizeDiscordProxyUrl, parseBridgeCommand, parseGameLogLine, resolveMessageBridgeRules } from "./message-bridge.js";

test("parses PalDefender chat", () => {
  assert.deepEqual(
    parseGameLogLine("[12:34:56][info] [Chat::Global]['Alice' (UserId=steam_1)]: hello"),
    { type: "chat", channel: "Global", author: "Alice", text: "hello" },
  );
});

test("parses death and capture events", () => {
  assert.deepEqual(
    parseGameLogLine("[12:34:56][info] 'Alice' (UserId=steam_1) was attacked by a wild 'Lamball' and died."),
    { type: "death", player: "Alice", killerPal: "Lamball" },
  );
  assert.deepEqual(
    parseGameLogLine("[12:34:56][info] 'Alice' (UserId=steam_1) has captured Pal 'Lamball' at 1 2 3."),
    { type: "capture", player: "Alice", pal: "Lamball" },
  );
});

test("ignores unrelated log lines", () => {
  assert.equal(parseGameLogLine("[12:34:56][info] REST API started"), null);
});

test("localizes Pal names and game events in all bridge languages", () => {
  const capture = { type: "capture", player: "Alice", pal: "SheepBall" } as const;
  assert.equal(localizePalName("SheepBall", "zh-TW"), "棉悠悠");
  assert.equal(localizePalName("BOSS_SheepBall", "zh-CN"), "棉悠悠");
  assert.equal(localizePalName("棉悠悠", "en"), "Lamball");
  assert.equal(localizePalName("Lamball", "ja"), "モコロン");
  assert.equal(localizePalName("UnknownPal", "en"), "UnknownPal");
  assert.equal(formatGameEvent(capture, "zh-TW"), "● Alice 捕捉了 棉悠悠");
  assert.equal(formatGameEvent(capture, "zh-CN"), "● Alice 捕捉了 棉悠悠");
  assert.equal(formatGameEvent(capture, "en"), "● Alice captured Lamball");
  assert.equal(formatGameEvent(capture, "ja"), "● Alice モコロンを捕まえました");
});

test("parses bridge commands with a custom prefix", () => {
  assert.deepEqual(parseBridgeCommand("!give steam_1 Wood 20", "!"), {
    name: "give",
    args: ["steam_1", "Wood", "20"],
  });
  assert.equal(parseBridgeCommand("hello", "!"), null);
});

test("migrates global bridge rules while preserving channel overrides", () => {
  assert.deepEqual(
    resolveMessageBridgeRules(
      { relayGameToGroup: true, commandPrefix: "!" },
      { relayGroupToGame: false, relayGameToGroup: false, notifyJoinLeave: false, notifyCapture: true, notifyDeath: false, commandPrefix: "/" },
    ),
    { relayGroupToGame: false, relayGameToGroup: true, notifyJoinLeave: false, notifyCapture: true, notifyDeath: false, commandPrefix: "!" },
  );
});

test("normalizes supported Discord proxy URLs", () => {
  assert.equal(normalizeDiscordProxyUrl("127.0.0.1:7890"), "http://127.0.0.1:7890/");
  assert.equal(normalizeDiscordProxyUrl("socks5://user:pass@127.0.0.1:1080"), "socks5://user:pass@127.0.0.1:1080");
  assert.throws(() => normalizeDiscordProxyUrl("ftp://127.0.0.1:21"), /HTTP、HTTPS、SOCKS4/);
  assert.throws(() => normalizeDiscordProxyUrl("http://127.0.0.1"), /包含端口/);
});

test("builds constrained admin grant commands", () => {
  assert.deepEqual(buildAdminGrantCommand("give", ["steam_1", "Wood", "20"]), {
    rcon: "give steam_1 Wood 20",
    confirmation: "已发送道具\n玩家: steam_1\n道具: Wood ×20",
  });
  assert.deepEqual(buildAdminGrantCommand("givepal", ["steam_1", "Lamball", "50"]), {
    rcon: "givepal steam_1 Lamball 50",
    confirmation: "已发送帕鲁\n玩家: steam_1\n帕鲁: 棉悠悠 (Lamball) · Lv.50",
  });
  assert.equal(
    buildAdminGrantCommand("givepal", ["steam_1", "SheepBall", "50"], "en").confirmation,
    "Pal Granted\nPlayer: steam_1\nPal: Lamball (SheepBall) · Lv.50",
  );
});

test("rejects RCON injection and out-of-range grants", () => {
  assert.throws(() => buildAdminGrantCommand("give", ["steam_1", "Wood;Save", "1"]), /道具 ID/);
  assert.throws(() => buildAdminGrantCommand("give", ["steam_1", "Wood", "100000"]), /1-99999/);
  assert.throws(() => buildAdminGrantCommand("givepal", ["steam_1", "Lamball", "256"]), /1-255/);
});
