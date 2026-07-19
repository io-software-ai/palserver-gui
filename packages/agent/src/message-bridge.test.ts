import assert from "node:assert/strict";
import test from "node:test";
import { localizePalName, localizePassive } from "@palserver/shared";
import { buildAdminGrantCommand, formatGameEvent, formatIvs, formatJoinLeave, formatPalLine, formatPlayerItem, normalizeDiscordProxyUrl, parseBridgeCommand, parseGameLogLine, resolveMessageBridgeRules } from "./message-bridge.js";

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

test("localizes passive names in all bridge languages", () => {
  // 传说 / Legend / 伝説 — 测试三语,ja 暂用 en fallback
  assert.equal(localizePassive("Legend", "zh-CN"), "传说");
  assert.equal(localizePassive("Legend", "zh-TW"), "傳說");
  assert.equal(localizePassive("Legend", "en"), "Legend");
  assert.equal(localizePassive("Legend", "ja"), "Legend");
  // 冰帝 / Ice Emperor — 也覆盖 rank4 词条
  assert.equal(localizePassive("ElementBoost_Ice_2_PAL", "zh-CN"), "冰帝");
  // 未知 id 直接返回原文
  assert.equal(localizePassive("UnknownTrait_xyz", "zh-CN"), "UnknownTrait_xyz");
});

test("formats join/leave with [+] / [-] prefix in all 4 languages", () => {
  assert.equal(formatJoinLeave(true, "Alice", "zh-CN"), "[+] 玩家 [Alice] 进入了服务器");
  assert.equal(formatJoinLeave(false, "Alice", "zh-CN"), "[-] 玩家 [Alice] 离开了服务器");
  assert.equal(formatJoinLeave(true, "Alice", "zh-TW"), "[+] 玩家 [Alice] 加入了伺服器");
  assert.equal(formatJoinLeave(true, "Alice", "en"), "[+] Player [Alice] joined the server");
  assert.equal(formatJoinLeave(false, "Alice", "ja"), "[-] プレイヤー [Alice] がサーバーから退出しました");
});

test("formats /players item row with level + ping in all 4 languages", () => {
  // 4 语言都用同一模板 "Lv.X - Yms"(游戏内通用)
  for (const lang of ["zh-CN", "zh-TW", "en", "ja"] as const) {
    assert.equal(formatPlayerItem(1, "Alice", 30, 42, lang), "1. Alice - Lv.30 - 42ms");
  }
});

test("formatIvs omits zero / missing segments and trims to short form", () => {
  // 心 67 / 攻 0 / 防 90: 攻为 0 应被丢弃,展示心+防
  assert.equal(formatIvs({ hp: 67, attack: 0, defense: 90 }, "zh-CN"), "IVs(心67|防90)");
  // 全部 0 → 视为无 IVs
  assert.equal(formatIvs({ hp: 0, attack: 0, defense: 0 }, "zh-CN"), "");
  // 全空 → 空
  assert.equal(formatIvs(undefined, "zh-CN"), "");
  // 4 维都 > 0
  assert.equal(formatIvs({ hp: 100, attack: 50, defense: 80, workSpeed: 70 }, "zh-CN"), "IVs(心100|攻50|防80|工速70)");
  // 英文:HP/ATK/DEF/Work
  assert.equal(formatIvs({ hp: 50, attack: 70, defense: 90 }, "en"), "IVs(HP50|ATK70|DEF90)");
});

test("formatPalLine: boss + IVs + passives (no condensation)", () => {
  const line = formatPalLine(
    {
      instanceId: "x", palId: "Frostallion", nickname: "", gender: "Female", level: 60, shiny: false, location: "team",
      ivs: { hp: 67, attack: 0, defense: 90 },
      passives: ["Legend", "ElementBoost_Ice_2_PAL", "PAL_ALLAttack_down1"],
      isBoss: true,
    },
    "zh-CN",
  );
  // - 唤冬兽(BOSS) Lv.60 (♀) - IVs(心67|防90)\n  词条:[传说 | 冰帝 | 胆小]
  assert.equal(
    line,
    "- 唤冬兽(BOSS) Lv.60 (♀) - IVs(心67|防90)\n  词条:[传说 | 冰帝 | 胆小]",
  );
});

test("formatPalLine: non-boss pal in palbox with nickname but no IVs", () => {
  const line = formatPalLine(
    {
      instanceId: "y", palId: "Nox", nickname: "露娜蒂", gender: "Male", level: 6, shiny: false, location: "palbox",
      passives: ["ElementResist_Earth_1_PAL"],
    },
    "zh-CN",
  );
  // 昵称 != palId,展示 "nickname · 物种名";没 IVs 走单行
  assert.equal(line, "- 露娜蒂 · 露娜蒂 Lv.6 (♂) - [抗震结构]");
});

test("formatPalLine: shiny pal with no passives shows [无词条] fallback", () => {
  const line = formatPalLine(
    { instanceId: "z", palId: "Lamball", nickname: "", gender: "Female", level: 2, shiny: false, location: "team" },
    "zh-CN",
  );
  assert.equal(line, "- 棉悠悠 Lv.2 (♀) - [无词条]");
});

test("formatPalLine: condensed rank shows leading ★ stars", () => {
  const line = formatPalLine(
    {
      instanceId: "w", palId: "Mau", nickname: "", gender: "Male", level: 18, shiny: false, location: "team",
      passives: ["CraftSpeed_down2"], rank: 2,
    },
    "zh-CN",
  );
  assert.equal(line, "- ★★喵丝特 Lv.18 (♂) - [偷懒成瘾]");
});

test("formatPalLine: 4-language sanity check (en/ja)", () => {
  const pal = {
    instanceId: "a", palId: "Frostallion", nickname: "", gender: "Female", level: 60, shiny: false, location: "team" as const,
    passives: ["Legend"],
  };
  // 物种名走 localizePalName(4 语言都翻);en 保 ID,ja 翻译为日文
  assert.equal(formatPalLine(pal, "en"), "- Frostallion Lv.60 (♀) - [Legend]");
  assert.equal(formatPalLine(pal, "ja"), "- グレイシャル Lv.60 (♀) - [Legend]");
});
