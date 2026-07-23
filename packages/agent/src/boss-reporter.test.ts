import assert from "node:assert/strict";
import test from "node:test";
import { fetchRemoteBossLua, versionFromReleaseUrl } from "./boss-reporter.js";

test("parses the release tag from a main.lua asset URL", () => {
  assert.equal(
    versionFromReleaseUrl(
      "https://github.com/io-software-ai/palserver-boss-reporter/releases/download/v1.6/main.lua",
    ),
    "1.6",
  );
});

test("downloads main.lua through latest/download without using the GitHub API", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/releases/latest/download/main.lua")) {
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "https://github.com/io-software-ai/palserver-boss-reporter/releases/download/1.6/main.lua",
        },
      });
    }
    if (url.endsWith("/releases/download/1.6/main.lua")) {
      return new Response("-- PalserverBossReporter\nreturn {}", { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const result = await fetchRemoteBossLua();
    assert.equal(result?.version, "1.6");
    assert.match(result?.lua ?? "", /PalserverBossReporter/);
    assert.equal(calls.some((url) => url.includes("api.github.com")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
