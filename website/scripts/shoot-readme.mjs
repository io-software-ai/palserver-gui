import { chromium } from "playwright";
const OUT = "/private/tmp/claude-501/-Users-eason-Studio-projects-palserver-gui/07316a82-905d-4095-85e8-f7f04e2ab0e9/scratchpad/shots";
const ID = process.env.INST_ID;
const AG = "http://127.0.0.1:8299";

const now = Date.now();
const iso = (min) => new Date(now - min * 60000).toISOString();
const PLAYERS = [
  { name: "阿魯",    accountName: "aru_0522",   level: 54, ping: 18, x: -37821, y: 129443, builds: 212, mins: 5820, sessions: 61 },
  { name: "Kuro",    accountName: "kuro_nya",   level: 51, ping: 36, x: 182930, y: -40112, builds: 145, mins: 4890, sessions: 48 },
  { name: "Mei",     accountName: "meimei",     level: 49, ping: 27, x: -8112,  y: 66801,  builds: 98,  mins: 4310, sessions: 52 },
  { name: "波奇塔",  accountName: "pochita",    level: 46, ping: 55, x: 250440, y: 190022, builds: 61,  mins: 3260, sessions: 39 },
];
const OFFLINE = [
  { name: "小海",  accountName: "umi_04",    level: 41, mins: 2110, sessions: 27, lastMin: 660 },
  { name: "Leo",   accountName: "leo_tw",    level: 33, mins: 980,  sessions: 12, lastMin: 2940 },
];
const uid = (i) => "steam_7656119" + String(80011000 + i * 7).padStart(8, "0");

const live = {
  available: true,
  info: { version: "v0.6.1.68370", servername: "好友的帕魯樂園", description: "週末一起肝帕魯", worldguid: "A7F3E2D8C1B04956" },
  metrics: { serverfps: 59, currentplayernum: 4, serverframetime: 16.9, maxplayernum: 32, uptime: 187260, basecampnum: 9, days: 47 },
  players: PLAYERS.map((p, i) => ({
    name: p.name, accountName: p.accountName, playerId: "pid_" + i, userId: uid(i), ip: "10.0.0." + (i + 2),
    ping: p.ping, location_x: p.x, location_y: p.y, level: p.level, building_count: p.builds,
  })),
};
const known = [
  ...PLAYERS.map((p, i) => ({ userId: uid(i), name: p.name, accountName: p.accountName, online: true,
    firstSeen: iso(60 * 24 * 40), lastSeen: iso(0), sessions: p.sessions, playtimeSeconds: p.mins * 60, lastLevel: p.level, guildName: "帕魯開拓團" })),
  ...OFFLINE.map((p, i) => ({ userId: uid(10 + i), name: p.name, accountName: p.accountName, online: false,
    firstSeen: iso(60 * 24 * 35), lastSeen: iso(p.lastMin), sessions: p.sessions, playtimeSeconds: p.mins * 60, lastLevel: p.level, guildName: "帕魯開拓團" })),
];
const presence = [
  { at: iso(2),   type: "join",  userId: uid(3), name: "波奇塔" },
  { at: iso(34),  type: "join",  userId: uid(2), name: "Mei" },
  { at: iso(51),  type: "leave", userId: uid(10), name: "小海" },
  { at: iso(75),  type: "join",  userId: uid(1), name: "Kuro" },
  { at: iso(96),  type: "join",  userId: uid(0), name: "阿魯" },
  { at: iso(140), type: "join",  userId: uid(10), name: "小海" },
];
const mods = {
  supported: true,
  ue4ss: { installed: true, version: "3.0.1" },
  paldefender: { installed: true, version: "1.10.2" },
  luaMods: [ { name: "PalDefender", enabled: true }, { name: "BetterSpawns", enabled: true }, { name: "ChatCommands", enabled: false } ],
  luaModsDir: "Pal/Binaries/Win64/ue4ss/Mods",
  pakMods: ["JPVoicePack_P.pak"],
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(([conn]) => {
  localStorage.setItem("palserver.connection", conn);
  localStorage.setItem("palserver.lang", "zh");
  localStorage.setItem("palserver.announcementsSeen", JSON.stringify([]));
}, [JSON.stringify({ url: AG, token: "dev" })]);
const page = await ctx.newPage();

// 擋掉公告來源,截圖不被歡迎彈窗打擾
await page.route("**raw.githubusercontent.com/**", (r) => r.abort());
await page.route("**/announcement.md", (r) => r.fulfill({ body: "", contentType: "text/markdown" }));

// mock/patch 層
await page.route("**/api/instances", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  const list = await res.json();
  for (const inst of list) {
    if (inst.id === ID) Object.assign(inst, { status: "running", gameVersion: "v0.6.1.68370", enhancements: ["paldefender", "ue4ss"] });
  }
  list.push(
    { ...list[0], id: "demo-2", name: "公會夜戰服", gamePort: 8213, status: "running", gameVersion: "v0.6.1.68370", enhancements: [], updateAvailable: false, installError: null, installProgress: null },
    { ...list[0], id: "demo-3", name: "週末活動服", gamePort: 8215, status: "installing", gameVersion: null, enhancements: [], updateAvailable: false, installError: null, installProgress: 47.3 },
  );
  await route.fulfill({ json: list });
});
await page.route(`**/api/instances/${ID}`, async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  const d = await res.json();
  Object.assign(d, { status: "running", pid: 24816, runtimeId: "24816", gameVersion: "v0.6.1.68370", updateAvailable: false,
    serverDir: null, effectiveServerDir: "D:\\palworld\\friends-server" });
  await route.fulfill({ json: d });
});
await page.route(`**/api/instances/${ID}/version`, (r) => {
  if (r.request().method() !== "GET") return r.continue();
  r.fulfill({ json: { supported: true, gameVersion: "v0.6.1.68370", installedBuild: "4441848255153707890",
    latestBuild: "4441848255153707890", latestUpdatedAt: "2026-07-10T03:04:08Z", updateAvailable: false,
    checkedAt: new Date().toISOString() } });
});
await page.route(`**/api/instances/${ID}/live`, (r) => r.fulfill({ json: live }));
await page.route(`**/api/instances/${ID}/players/known`, (r) => r.fulfill({ json: known }));
await page.route(`**/api/instances/${ID}/presence**`, (r) => r.fulfill({ json: presence }));
await page.route(`**/api/instances/${ID}/mods`, (r) => {
  if (r.request().method() !== "GET") return r.continue();
  r.fulfill({ json: mods });
});

const shot = async (name, h = 900) => {
  await page.setViewportSize({ width: 1440, height: h });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
};

await page.goto("http://localhost:5199/");
await page.waitForSelector("text=好友的帕魯樂園");
await page.waitForTimeout(800);
if (await page.locator("div.z-40").count()) {
  await page.evaluate(() => {
    try {
      const c = JSON.parse(localStorage.getItem("palserver.announcements") ?? "null");
      const ids = (c && (c.items ?? c.data ?? c) || []).map?.((a) => a.id) ?? [];
      localStorage.setItem("palserver.announcementsSeen", JSON.stringify(ids));
    } catch {}
  });
  await page.reload();
  await page.waitForSelector("text=好友的帕魯樂園");
  await page.waitForTimeout(500);
}
await shot("dashboard", 620);

await page.click("text=好友的帕魯樂園");
await page.waitForSelector("text=總覽");
await page.waitForTimeout(600);
await shot("overview");

const tab = async (label) => { await page.click(`text=${label}`); await page.waitForTimeout(800); };
await tab("玩家");   await shot("players");
await tab("世界設定"); await shot("settings");
await tab("引擎微調"); await shot("engine");
await tab("存檔備份"); await shot("saves");
await tab("模組");   await shot("mods");
await browser.close();
