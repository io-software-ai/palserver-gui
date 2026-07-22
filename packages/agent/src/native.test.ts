import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyServerExit, decodeWindowsLog, linesToReplay } from "./native.js";

test("decodeWindowsLog: Windows GBK system error falls back from invalid UTF-8", () => {
  assert.equal(decodeWindowsLog(Buffer.from([0xB2, 0xCE, 0xCA, 0xFD, 0xCE, 0xDE, 0xD0, 0xA7])), "参数无效");
});

test("decodeWindowsLog: mixed UTF-8 and GBK lines preserve both", () => {
  const bytes = Buffer.concat([
    Buffer.from("啟動完成\n", "utf8"),
    Buffer.from([0xB2, 0xCE, 0xCA, 0xFD, 0xCE, 0xDE, 0xD0, 0xA7]),
  ]);
  assert.equal(decodeWindowsLog(bytes), "啟動完成\n参数无效");
});

test("linesToReplay: replay=0 不補任何歷史(slice(-0)=整包 的陷阱)", () => {
  // 這是「重啟時舊捕捉/死亡誤報」的根因:log-event-tracker 用 replay=0,必須真的回 []。
  assert.deepEqual(linesToReplay(["a", "b", "c"], 0), []);
  assert.deepEqual(linesToReplay([], 0), []);
  assert.deepEqual(linesToReplay(["a", "b", "c"], 2), ["b", "c"]);
  assert.deepEqual(linesToReplay(["a", "b", "c"], 10), ["a", "b", "c"]);
});

test("classifyServerExit: 我們要求的停止一律算正常 exited", () => {
  assert.equal(classifyServerExit(0, null, true), "exited");
  assert.equal(classifyServerExit(1, null, true), "exited"); // killTree 送 SIGTERM/非 0 也是我們要的停止
  assert.equal(classifyServerExit(null, "SIGKILL", true), "exited");
});

test("classifyServerExit: 非預期退出依 code/signal 判崩潰", () => {
  assert.equal(classifyServerExit(0, null, false), "exited"); // 乾淨退出(罕見的非預期正常關)
  assert.equal(classifyServerExit(1, null, false), "crash"); // 非 0 = 崩潰
  assert.equal(classifyServerExit(139, null, false), "crash"); // segfault
  assert.equal(classifyServerExit(null, "SIGSEGV", false), "crash"); // 被 signal 砍 = 崩潰
});
