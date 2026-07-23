import type { KnownPlayer, PdPlayerSummary } from "@palserver/shared";

interface PlayerIdentity {
  exact: string;
  platform?: string;
  numeric?: string;
}

const playerIdentity = (userId: string): PlayerIdentity => {
  const exact = userId.trim().toLowerCase();
  const prefixed = exact.match(/^([a-z][a-z0-9-]*)_(\d+)$/);
  if (prefixed) return { exact, platform: prefixed[1], numeric: prefixed[2] };
  return { exact, ...(exact.match(/^\d+$/) ? { numeric: exact } : {}) };
};

const nameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

const identitiesMatch = (left: PlayerIdentity, right: PlayerIdentity): boolean =>
  left.exact === right.exact ||
  Boolean(
    left.numeric &&
    left.numeric === right.numeric &&
    (!left.platform || !right.platform),
  );

function matchingIndices(
  players: KnownPlayer[],
  identity: PlayerIdentity,
  playerName: string,
): number[] {
  const exact = players
    .map((player, index) => ({ identity: playerIdentity(player.userId), index }))
    .filter((candidate) => candidate.identity.exact === identity.exact)
    .map((candidate) => candidate.index);
  if (exact.length) return exact;

  const compatible = players
    .map((player, index) => ({ player, identity: playerIdentity(player.userId), index }))
    .filter((candidate) => identitiesMatch(candidate.identity, identity));
  if (compatible.length <= 1) return compatible.map((candidate) => candidate.index);

  const name = nameKey(playerName);
  if (!name) return compatible.map((candidate) => candidate.index);
  const named = compatible.filter((candidate) => nameKey(candidate.player.name) === name);
  return named.length === 1
    ? named.map((candidate) => candidate.index)
    : compatible.map((candidate) => candidate.index);
}

function mergePlayer(player: PdPlayerSummary, previous?: KnownPlayer): KnownPlayer {
  return {
    userId: previous?.userId ?? player.userId.trim(),
    name: player.name.trim() || previous?.name || "",
    accountName: previous?.accountName ?? "",
    online: player.online,
    firstSeen: previous?.firstSeen ?? "",
    lastSeen: previous?.lastSeen ?? "",
    sessions: previous?.sessions ?? 0,
    playtimeSeconds: previous?.playtimeSeconds ?? 0,
    lastLevel: previous?.lastLevel ?? 0,
    ...(player.guildName.trim() ? { guildName: player.guildName.trim() } : {}),
  };
}

/**
 * Merge PalDefender's save-backed roster with the agent's presence history.
 *
 * PalDefender documents UserId as optional for offline save entries. Those
 * entries cannot be keyed directly, so use a unique player name as a guarded
 * fallback. Ambiguous or unknown nameless-ID entries are omitted because a
 * KnownPlayer without a UserId cannot be targeted by any player action.
 */
export function mergeKnownPlayers(
  ownPlayers: KnownPlayer[],
  pdPlayers: PdPlayerSummary[],
): KnownPlayer[] {
  const remaining = [...ownPlayers];
  const merged: KnownPlayer[] = [];
  const missingId = pdPlayers.filter((player) => !playerIdentity(player.userId).exact);

  for (const player of pdPlayers) {
    const identity = playerIdentity(player.userId);
    if (!identity.exact || matchingIndices(merged, identity, player.name).length) continue;
    const previousMatches = matchingIndices(remaining, identity, player.name);
    // A bare numeric ID can match multiple platforms. Do not guess or add a
    // third representation when the platform cannot be determined safely.
    if (previousMatches.length > 1) continue;
    const previous = previousMatches.length === 1
      ? remaining.splice(previousMatches[0], 1)[0]
      : undefined;
    merged.push(mergePlayer(player, previous));
  }

  const pdNameCounts = new Map<string, number>();
  for (const player of missingId) {
    const name = nameKey(player.name);
    if (name) pdNameCounts.set(name, (pdNameCounts.get(name) ?? 0) + 1);
  }

  for (const player of missingId) {
    const name = nameKey(player.name);
    if (!name || pdNameCounts.get(name) !== 1) continue;
    const matches = remaining
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => nameKey(candidate.name) === name);
    if (matches.length !== 1) continue;
    const [{ candidate, index }] = matches;
    const identity = playerIdentity(candidate.userId);
    if (!identity.exact || matchingIndices(merged, identity, candidate.name).length) continue;
    remaining.splice(index, 1);
    merged.push(mergePlayer(player, candidate));
  }

  const seenExactIds = new Set(merged.map((player) => playerIdentity(player.userId).exact));
  for (const player of remaining) {
    const id = playerIdentity(player.userId).exact;
    if (!id || seenExactIds.has(id)) continue;
    merged.push(player);
    seenExactIds.add(id);
  }
  return merged;
}
