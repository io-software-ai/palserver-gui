import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRconBase64, encodeRconPacket } from "./rcon.js";

test("RCON Base64 preserves Unicode commands and responses", () => {
  const command = "renameplayer steam_1 中文名字";
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const packet = encodeRconPacket(2, 2, encoded);
  assert.equal(packet.subarray(12, -2).toString("utf8"), encoded);
  assert.equal(decodeRconBase64(Buffer.from("醒目警示", "utf8").toString("base64")), "醒目警示");
});

test("RCON Base64 decoder leaves ordinary non-Base64 responses unchanged", () => {
  assert.equal(decodeRconBase64("Unknown command"), "Unknown command");
});
