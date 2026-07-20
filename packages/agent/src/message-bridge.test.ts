import assert from "node:assert/strict";
import test from "node:test";
import { localizePalName } from "@palserver/shared";
import { localizeItem, localizePassive, t, webPublic } from "./i18n.js";
import { buildAdminGrantCommand, buildDiscordImageMultipart, buildOneBotForwardEnvelope, buildOneBotForwardNodes, formatGameEvent, formatInventoryReply, formatIvs, formatJoinLeave, formatPagedBridgeReply, formatPalLine, formatPlayerItem, mergeStoredBridgeConfig, normalizeDiscordProxyUrl, paginateBridgeReply, parseBridgeCommand, parseGameLogLine, parseRelayMessage, playerQueryIdentifier, resolveMessageBridgeRules, resolvePlayerIdentifier, resolveSavePlayer, saveInventoryToPdItems, savePalToPdPal, splitOneBotForwardContent } from "./message-bridge.js";

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

test("localizes boss, companion, and capturable human event IDs", () => {
  assert.equal(localizePalName("Male_Breeder01_v01", "zh-CN"), "岛民");
  assert.equal(localizePalName("Male_Breeder01_v01", "en"), "Islander");
  assert.equal(localizePalName("BOSS_KingWhale_otomo", "zh-CN"), "奥沧鲸");
  assert.equal(localizePalName("BOSS_PoseidonOrca", "zh-CN"), "海皇鲸");
  assert.equal(localizePalName("BOSS_FlowerDoll", "zh-CN"), "花丽娜");
  assert.equal(localizePalName("BOSS_FlowerDoll_Fire", "zh-CN"), "樱丽娜");
});

test("parses bridge commands with a custom prefix", () => {
  assert.deepEqual(parseBridgeCommand("!give steam_1 Wood 20", "!"), {
    name: "give",
    args: ["steam_1", "Wood", "20"],
  });
  assert.equal(parseBridgeCommand("hello", "!"), null);
});

test("filters and strips the optional message relay prefix", () => {
  assert.equal(parseRelayMessage("hello", ""), "hello");
  assert.equal(parseRelayMessage("# hello", "#"), "hello");
  assert.equal(parseRelayMessage("#hello", "#"), "hello");
  assert.equal(parseRelayMessage("hello", "#"), null);
  assert.equal(parseRelayMessage("#", "#"), null);
});

test("resolves a player name to the UserId required by PalDefender", () => {
  const players = [{
    userId: "steam_76561198000000000",
    name: "BiHan",
    accountName: "bihan_account",
    online: true,
    firstSeen: "2026-07-19T00:00:00.000Z",
    lastSeen: "2026-07-19T00:00:00.000Z",
    sessions: 0,
    playtimeSeconds: 0,
    lastLevel: 60,
  }];
  assert.equal(resolvePlayerIdentifier("BiHan", players), "steam_76561198000000000");
  assert.equal(resolvePlayerIdentifier("Bi", players), "steam_76561198000000000");
  assert.equal(resolvePlayerIdentifier("bi", players), "steam_76561198000000000");
  assert.equal(resolvePlayerIdentifier("Han", players), "steam_76561198000000000");
  assert.equal(resolvePlayerIdentifier("BIHAN_ACCOUNT", players), "steam_76561198000000000");
  assert.equal(resolvePlayerIdentifier("steam_76561198000000000", players), "steam_76561198000000000");
  assert.equal(resolvePlayerIdentifier("unknown", players), "unknown");
});

test("does not guess when a fuzzy player name matches multiple players", () => {
  const base = {
    accountName: "",
    online: true,
    firstSeen: "2026-07-19T00:00:00.000Z",
    lastSeen: "2026-07-19T00:00:00.000Z",
    sessions: 0,
    playtimeSeconds: 0,
    lastLevel: 60,
  };
  const players = [
    { ...base, userId: "steam_1", name: "BiHan" },
    { ...base, userId: "steam_2", name: "BiYun" },
  ];
  assert.equal(resolvePlayerIdentifier("Bi", players), "Bi");
  assert.equal(resolvePlayerIdentifier("BiHan", players), "steam_1");
});

test("accepts Unicode player queries and resolves Chinese fuzzy names", () => {
  const players = [{
    userId: "steam_zh", name: "飞翔的小明", accountName: "",
    online: false, firstSeen: "2026-07-19T00:00:00.000Z", lastSeen: "2026-07-19T00:00:00.000Z",
    sessions: 0, playtimeSeconds: 0, lastLevel: 60,
  }];
  assert.equal(playerQueryIdentifier("飞翔", "玩家 UserId", "zh-CN"), "飞翔");
  assert.equal(playerQueryIdentifier("プレイヤー", "プレイヤー UserId", "ja"), "プレイヤー");
  assert.equal(resolvePlayerIdentifier("小明", players), "steam_zh");
  assert.throws(() => playerQueryIdentifier("小明;quit", "玩家 UserId", "zh-CN"), /需要有效/);
});

test("resolves offline save players by UID, exact name, or unique fuzzy name", () => {
  const players = [
    { uid: "ABC-123", name: "BiHan" },
    { uid: "DEF-456", name: "BiYun" },
  ];
  assert.equal(resolveSavePlayer("abc123", players)?.name, "BiHan");
  assert.equal(resolveSavePlayer("bihan", players)?.uid, "ABC-123");
  assert.equal(resolveSavePlayer("Han", players)?.uid, "ABC-123");
  assert.equal(resolveSavePlayer("Bi", players), null);
  assert.equal(resolveSavePlayer(["steam_1", "BiHan"], players)?.uid, "ABC-123");
  assert.equal(resolveSavePlayer("飞翔", [{ uid: "ZH-1", name: "飞翔的小明" }])?.uid, "ZH-1");
});

test("converts offline save Pals to bridge Pal rows", () => {
  assert.deepEqual(savePalToPdPal({
    instanceId: "pal-1", characterId: "BOSS_Frostallion", nickname: "", level: 60, gender: "female",
    rank: 4, isLucky: true, isBoss: true, talentHp: 67, talentShot: 0, talentDefense: 90,
    passives: ["Legend"], location: "party",
  }), {
    instanceId: "pal-1", palId: "BOSS_Frostallion", nickname: "", level: 60, gender: "Female",
    rank: 3, shiny: true, isBoss: true, ivs: { hp: 67, attack: 0, defense: 90 },
    passives: ["Legend"], location: "team",
  });
  assert.equal(savePalToPdPal({
    instanceId: "pal-2", characterId: "Lamball", level: null, gender: null, rank: 0,
    isLucky: false, isBoss: false, talentHp: null, talentShot: null, talentDefense: null,
    passives: [], location: "unknown",
  }).location, "basecamp");
});

test("converts offline save inventory containers and money", () => {
  assert.deepEqual(saveInventoryToPdItems({
    money: 50,
    common: [{ itemId: "Wood", count: 10 }],
    essential: [{ itemId: "TechnologyBook_G1", count: 1 }],
    weapons: [{ itemId: "Bow", count: 1 }],
    armor: [{ itemId: "Shield_01", count: 1 }],
    food: [{ itemId: "Baked_Berries", count: 3 }],
  }), [
    { itemId: "Wood", count: 10, container: "Items" },
    { itemId: "TechnologyBook_G1", count: 1, container: "KeyItems" },
    { itemId: "Bow", count: 1, container: "Weapons" },
    { itemId: "Shield_01", count: 1, container: "Armor" },
    { itemId: "Baked_Berries", count: 3, container: "Food" },
    { itemId: "Money", count: 50, container: "Items" },
  ]);
});

test("paginates long command replies without losing paragraph content", () => {
  const text = "alpha\n\nbeta\n\ngamma";
  const pages = paginateBridgeReply(text, 11);
  assert.deepEqual(pages, ["alpha\n\nbeta", "gamma"]);
  assert.equal(pages.join("\n\n"), text);
});

test("formats a selected Discord or Telegram page with the next command", () => {
  const text = `${"A".repeat(140)}\n\n${"B".repeat(140)}`;
  const secondPage = formatPagedBridgeReply(text, 260, { nextCommand: "/pals Bi", requestedPage: 2 }, "zh-CN");
  assert.match(secondPage, /^\[2\/2\]\nB+/);
  assert.match(secondPage, /下一页: \/pals Bi 1$/);
  assert.ok(secondPage.length <= 260);
});

test("builds NapCat-compatible OneBot forward nodes", () => {
  assert.deepEqual(buildOneBotForwardNodes(["first", "second"], "3161195955", "H0vvaro1"), [
    {
      type: "node",
      data: {
        user_id: "3161195955",
        nickname: "H0vvaro1",
        content: [{ type: "text", data: { text: "first" } }],
      },
    },
    {
      type: "node",
      data: {
        user_id: "3161195955",
        nickname: "H0vvaro1",
        content: [{ type: "text", data: { text: "second" } }],
      },
    },
  ]);
});

test("nests large OneBot replies in one forward envelope", () => {
  const pages = Array.from({ length: 12 }, (_, index) => `section-${index + 1}`);
  const envelope = buildOneBotForwardEnvelope(pages, "3161195955", "H0vvaro1");
  assert.equal(envelope.length, 2);
  const nestedNodes = envelope.flatMap((node) => (node.data as { content: Array<Record<string, unknown>> }).content);
  assert.equal(nestedNodes.length, 12);
  assert.deepEqual(nestedNodes.map((node) => ((node.data as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]),
    pages.map((page) => ({ type: "text", data: { text: page } })));
});

test("keeps short OneBot replies as direct forward nodes", () => {
  assert.deepEqual(
    buildOneBotForwardEnvelope(["first", "second"], "3161195955", "H0vvaro1"),
    buildOneBotForwardNodes(["first", "second"], "3161195955", "H0vvaro1"),
  );
});

test("builds Discord multipart image attachments without message text", () => {
  const multipart = buildDiscordImageMultipart([Buffer.from("png")], "test-boundary");
  const body = multipart.body.toString("latin1");
  assert.equal(multipart.contentType, "multipart/form-data; boundary=test-boundary");
  assert.match(body, /name="payload_json"/);
  assert.match(body, /name="files\[0\]"; filename="palserver-1\.png"/);
  assert.doesNotMatch(body, /"content"/);
});

test("groups OneBot pal replies into title, team, and storage nodes", () => {
  const text = [
    "[ 玩家 BiHan 的帕鲁阵容 ]",
    "【 队伍帕鲁 】\n- pal1\n- pal2",
    "【 终端帕鲁 (共 2 只) 】\n- pal3\n- pal4",
  ].join("\n\n");
  assert.deepEqual(splitOneBotForwardContent(text), [
    "[ 玩家 BiHan 的帕鲁阵容 ]",
    "【 队伍帕鲁 】\n- pal1\n- pal2",
    "【 终端帕鲁 (共 2 只) 】\n- pal3\n- pal4",
  ]);
});

test("splits only oversized OneBot pal reply sections", () => {
  const text = `[ 玩家 BiHan 的帕鲁阵容 ]\n\n【 终端帕鲁 (共 2 只) 】\n${"A".repeat(20)}\n${"B".repeat(20)}`;
  assert.deepEqual(splitOneBotForwardContent(text, 35), [
    "[ 玩家 BiHan 的帕鲁阵容 ]",
    "【 终端帕鲁 (共 2 只) 】",
    "A".repeat(20),
    "B".repeat(20),
  ]);
});

test("migrates global bridge rules while preserving channel overrides", () => {
  assert.deepEqual(
    resolveMessageBridgeRules(
      { relayGameToGroup: true, commandPrefix: "!" },
      { relayGroupToGame: false, relayGameToGroup: false, notifyJoinLeave: false, notifyCapture: true, notifyDeath: false, commandPrefix: "/" },
    ),
    { relayGroupToGame: false, relayGameToGroup: true, notifyJoinLeave: false, notifyCapture: true, notifyDeath: false, relayPrefix: "", commandPrefix: "!" },
  );
});

test("migrates legacy single-platform bridge config into channel instances", () => {
  const config = mergeStoredBridgeConfig({
    relayGameToGroup: false,
    onebot: { added: true, enabled: true, wsUrl: "ws://127.0.0.1:3001", groupId: "10001", accessToken: "secret", language: "zh-CN" },
  });
  assert.equal(config.channels.length, 1);
  assert.deepEqual(config.channels[0], {
    id: "onebot", platform: "onebot", enabled: true,
    relayGroupToGame: true, relayGameToGroup: false, notifyJoinLeave: true, notifyCapture: true, notifyDeath: true, relayPrefix: "", commandPrefix: "/",
    adminIds: [], language: "zh-CN", wsUrl: "ws://127.0.0.1:3001", groupId: "10001", accessToken: "secret",
  });
});

test("preserves multiple channels using the same bridge platform", () => {
  const config = mergeStoredBridgeConfig({ channels: [
    { id: "onebot-a", platform: "onebot", enabled: true, groupId: "10001", wsUrl: "ws://127.0.0.1:3001", accessToken: "a" },
    { id: "onebot-b", platform: "onebot", enabled: true, groupId: "10002", wsUrl: "ws://127.0.0.1:3002", accessToken: "b" },
  ] });
  assert.equal(config.channels.length, 2);
  assert.deepEqual(config.channels.map((channel) => [channel.id, channel.platform, "groupId" in channel ? channel.groupId : ""]), [
    ["onebot-a", "onebot", "10001"],
    ["onebot-b", "onebot", "10002"],
  ]);
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

test("localizes item names from the packaged game catalog", () => {
  assert.equal(localizeItem("Money", "zh-CN"), "金币");
  assert.equal(localizeItem("Money", "zh-TW"), "金幣");
  assert.equal(localizeItem("Money", "en"), "Gold Coin");
  assert.equal(localizeItem("UnknownItem_xyz", "ja"), "UnknownItem_xyz");
});

test("formats /items replies into translated inventory sections", () => {
  const reply = formatInventoryReply("feixiang", [
    { itemId: "Money", count: 12, container: "Items" },
    { itemId: "Money", count: 8, container: "Items" },
    { itemId: "TechnologyBook_G1", count: 1, container: "KeyItems" },
    { itemId: "Bow", count: 1, container: "Weapons" },
    { itemId: "Shield_01", count: 1, container: "Armor" },
  ], "zh-CN");
  assert.match(reply, /^\[ 玩家 feixiang 的背包 \]\n\n【普通物品】\n- 金币 ×20/);
  assert.match(reply, /\n\n【重要物品】\n-/);
  assert.match(reply, /\n\n【武器栏】\n-/);
  assert.match(reply, /\n\n【防具栏】\n- 普通护盾 ×1$/);
  assert.deepEqual(splitOneBotForwardContent(reply), reply.split("\n\n"));
});

test("resolves bridge translations from the packaged web resource layout", () => {
  assert.ok(webPublic());
  assert.equal(t("en", "指令執行失敗"), "Command failed");
  assert.equal(t("ja", "指令執行失敗"), "コマンドの実行に失敗しました");
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
    assert.equal(formatPlayerItem(1, "Alice", 30, 87.82142639160156, lang), "1. Alice - Lv.30 - 87.82ms");
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
