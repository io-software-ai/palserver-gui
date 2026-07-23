import assert from "node:assert/strict";
import test from "node:test";
import type { KnownPlayer, PdPlayerSummary } from "@palserver/shared";
import { mergeKnownPlayers } from "./player-roster.js";

const known = (patch: Partial<KnownPlayer> & Pick<KnownPlayer, "userId" | "name">): KnownPlayer => ({
  accountName: "",
  online: false,
  firstSeen: "2026-07-01T00:00:00.000Z",
  lastSeen: "2026-07-20T00:00:00.000Z",
  sessions: 3,
  playtimeSeconds: 3600,
  lastLevel: 10,
  ...patch,
});

const pd = (patch: Partial<PdPlayerSummary> & Pick<PdPlayerSummary, "userId" | "name">): PdPlayerSummary => ({
  playerUid: "",
  guildName: "",
  online: false,
  ip: "",
  ...patch,
});

test("mergeKnownPlayers merges PalDefender entries with missing UserId by unique name", () => {
  const result = mergeKnownPlayers(
    [
      known({ userId: "steam_76561198000000001", name: "Alice", lastLevel: 42 }),
      known({ userId: "steam_76561198000000002", name: "Bob", lastLevel: 21 }),
    ],
    [
      pd({ userId: "", name: "Alice", guildName: "Builders" }),
      pd({ userId: "", name: "Bob", guildName: "Explorers" }),
    ],
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((player) => player.userId), [
    "steam_76561198000000001",
    "steam_76561198000000002",
  ]);
  assert.deepEqual(result.map((player) => player.guildName), ["Builders", "Explorers"]);
  assert.deepEqual(result.map((player) => player.lastLevel), [42, 21]);
});

test("mergeKnownPlayers matches Steam IDs with and without the steam_ prefix", () => {
  const result = mergeKnownPlayers(
    [known({ userId: "steam_76561198000000001", name: "Old name", sessions: 8 })],
    [pd({ userId: "76561198000000001", name: "Current name", online: true })],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.userId, "steam_76561198000000001");
  assert.equal(result[0]?.name, "Current name");
  assert.equal(result[0]?.online, true);
  assert.equal(result[0]?.sessions, 8);
});

test("mergeKnownPlayers matches GDK and PS5 IDs with and without platform prefixes", () => {
  const result = mergeKnownPlayers(
    [
      known({ userId: "gdk_2533274963232060", name: "Xbox player", sessions: 5 }),
      known({ userId: "ps5_4877707100835767776", name: "PlayStation player", sessions: 7 }),
    ],
    [
      pd({ userId: "2533274963232060", name: "Xbox player", online: true }),
      pd({ userId: "4877707100835767776", name: "PlayStation player", online: false }),
    ],
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((player) => player.userId), [
    "gdk_2533274963232060",
    "ps5_4877707100835767776",
  ]);
  assert.deepEqual(result.map((player) => player.sessions), [5, 7]);
});

test("mergeKnownPlayers keeps different platforms separate when numeric IDs coincide", () => {
  const result = mergeKnownPlayers(
    [
      known({ userId: "gdk_1234567890123456", name: "Xbox player" }),
      known({ userId: "ps5_1234567890123456", name: "PlayStation player" }),
    ],
    [pd({ userId: "1234567890123456", name: "Unknown platform" })],
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((player) => player.userId), [
    "gdk_1234567890123456",
    "ps5_1234567890123456",
  ]);
});

test("mergeKnownPlayers omits unidentifiable PalDefender-only entries", () => {
  const result = mergeKnownPlayers(
    [known({ userId: "steam_76561198000000001", name: "Alice" })],
    [pd({ userId: "", name: "Unknown" })],
  );

  assert.deepEqual(result.map((player) => player.name), ["Alice"]);
});

test("mergeKnownPlayers does not guess when names are ambiguous", () => {
  const result = mergeKnownPlayers(
    [
      known({ userId: "steam_76561198000000001", name: "Same name" }),
      known({ userId: "steam_76561198000000002", name: "Same name" }),
    ],
    [pd({ userId: "", name: "Same name", guildName: "Guild" })],
  );

  assert.equal(result.length, 2);
  assert.equal(result.every((player) => player.guildName === undefined), true);
});
