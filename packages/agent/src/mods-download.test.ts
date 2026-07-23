import assert from "node:assert/strict";
import test from "node:test";
import { resolveFixedTagDownload } from "./mods.js";

test("resolves the fixed UE4SS asset without using the GitHub API", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.method, "HEAD");
    return new Response(null, {
      status: 200,
      headers: { "last-modified": "Sun, 19 Jul 2026 07:14:13 GMT" },
    });
  };

  try {
    const result = await resolveFixedTagDownload("ue4ss", "stable");
    assert.deepEqual(result, {
      version: "experimental-palworld (2026-07-19)",
      url: "https://github.com/Okaetsu/RE-UE4SS/releases/download/experimental-palworld/UE4SS-Palworld.zip",
    });
    assert.equal(calls.some((url) => url.includes("api.github.com")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
