import assert from "node:assert/strict";
import test from "node:test";
import { buildAdminGrantCommand, parseBridgeCommand, parseGameLogLine } from "./message-bridge.js";

test("parses PalDefender chat", () => {
  assert.deepEqual(
    parseGameLogLine("[12:34:56][info] [Chat::Global]['Alice' (UserId=steam_1)]: hello"),
    { type: "chat", text: "[游戏/Global] Alice: hello" },
  );
});

test("parses death and capture events", () => {
  assert.deepEqual(
    parseGameLogLine("[12:34:56][info] 'Alice' (UserId=steam_1) was attacked by a wild 'Lamball' and died."),
    { type: "death", text: "☠ Alice 被野生 Lamball 击杀" },
  );
  assert.deepEqual(
    parseGameLogLine("[12:34:56][info] 'Alice' (UserId=steam_1) has captured Pal 'Lamball' at 1 2 3."),
    { type: "capture", text: "● Alice 捕捉了 Lamball" },
  );
});

test("ignores unrelated log lines", () => {
  assert.equal(parseGameLogLine("[12:34:56][info] REST API started"), null);
});

test("parses bridge commands with a custom prefix", () => {
  assert.deepEqual(parseBridgeCommand("!give steam_1 Wood 20", "!"), {
    name: "give",
    args: ["steam_1", "Wood", "20"],
  });
  assert.equal(parseBridgeCommand("hello", "!"), null);
});

test("builds constrained admin grant commands", () => {
  assert.deepEqual(buildAdminGrantCommand("give", ["steam_1", "Wood", "20"]), {
    rcon: "give steam_1 Wood 20",
    confirmation: "已给 steam_1: Wood ×20",
  });
  assert.deepEqual(buildAdminGrantCommand("givepal", ["steam_1", "Lamball", "50"]), {
    rcon: "givepal steam_1 Lamball 50",
    confirmation: "已给 steam_1: Lamball Lv.50",
  });
});

test("rejects RCON injection and out-of-range grants", () => {
  assert.throws(() => buildAdminGrantCommand("give", ["steam_1", "Wood;Save", "1"]), /道具 ID/);
  assert.throws(() => buildAdminGrantCommand("give", ["steam_1", "Wood", "100000"]), /1-99999/);
  assert.throws(() => buildAdminGrantCommand("givepal", ["steam_1", "Lamball", "256"]), /1-255/);
});
