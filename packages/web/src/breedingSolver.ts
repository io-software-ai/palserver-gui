import type { SaveBreedingPal } from "@palserver/shared";

export type BreedingGender = "*" | "m" | "f";
export type BreedingRecipe = [string, BreedingGender, string, BreedingGender, string];

export interface BreedingData {
  source: string;
  license: string;
  version: string;
  recipes: BreedingRecipe[];
}

export interface BreedingNode {
  species: string;
  gender: BreedingGender;
  passiveMask: number;
  generation: number;
  breedCount: number;
  source?: SaveBreedingPal;
  parents?: readonly [BreedingNode, BreedingNode];
}

export interface BreedingSolution {
  target: BreedingNode | null;
  reachableSpecies: number;
}

function canonicalSpecies(id: string, names: Map<string, string>): string {
  const bare = id.replace(/^BOSS_/i, "");
  return names.get(bare.toLowerCase()) ?? bare;
}

function maskFor(passives: string[], desired: string[]): number {
  let mask = 0;
  for (let i = 0; i < desired.length; i++) {
    if (passives.includes(desired[i])) mask |= 1 << i;
  }
  return mask;
}

function stateKey(node: Pick<BreedingNode, "species" | "gender" | "passiveMask">): string {
  return `${node.species}\u0000${node.gender}\u0000${node.passiveMask}`;
}

function sourceScore(node: BreedingNode): number {
  if (!node.source) return 0;
  const location = { palbox: 4, base: 3, party: 2, unknown: 1 }[node.source.location];
  return (
    location * 1_000_000 +
    (node.source.talentHp ?? 0) +
    (node.source.talentShot ?? 0) +
    (node.source.talentDefense ?? 0)
  );
}

function better(candidate: BreedingNode, current?: BreedingNode): boolean {
  if (!current) return true;
  if (candidate.generation !== current.generation) return candidate.generation < current.generation;
  if (candidate.breedCount !== current.breedCount) return candidate.breedCount < current.breedCount;
  return sourceScore(candidate) > sourceScore(current);
}

function matchesGender(actual: BreedingGender, required: BreedingGender): boolean {
  return actual === "*" || required === "*" || actual === required;
}

function compatibleParents(a: BreedingNode, requiredA: BreedingGender, b: BreedingNode, requiredB: BreedingGender): boolean {
  if (!matchesGender(a.gender, requiredA) || !matchesGender(b.gender, requiredB)) return false;
  if (a.source && b.source && a.source.instanceId === b.source.instanceId) return false;

  const genderA = requiredA === "*" ? a.gender : requiredA;
  const genderB = requiredB === "*" ? b.gender : requiredB;
  return genderA === "*" || genderB === "*" || genderA !== genderB;
}

/**
 * PalCalc 配方上的有界動態規劃。先最小化最長代數,再最小化整棵樹的配種次數;
 * 詞條按遊戲的「雙親詞條去重後繼承」規則合併。新生帕魯視為可孵出任一性別。
 */
export function solveBreeding(
  data: BreedingData,
  owned: SaveBreedingPal[],
  targetId: string,
  desiredPassives: string[],
  maxGenerations: number,
): BreedingSolution {
  const canonical = new Map<string, string>();
  for (const [p1, , p2, , child] of data.recipes) {
    canonical.set(p1.toLowerCase(), p1);
    canonical.set(p2.toLowerCase(), p2);
    canonical.set(child.toLowerCase(), child);
  }

  const states = new Map<string, BreedingNode>();
  const add = (node: BreedingNode, dest = states) => {
    const key = stateKey(node);
    if (better(node, dest.get(key))) dest.set(key, node);
  };

  for (const pal of owned) {
    if (!pal.gender) continue;
    add({
      species: canonicalSpecies(pal.characterId, canonical),
      gender: pal.gender === "male" ? "m" : "f",
      passiveMask: maskFor(pal.passives, desiredPassives),
      generation: 0,
      breedCount: 0,
      source: pal,
    });
  }

  for (let generation = 1; generation <= Math.max(0, maxGenerations); generation++) {
    const bySpecies = new Map<string, BreedingNode[]>();
    for (const node of states.values()) {
      const list = bySpecies.get(node.species) ?? [];
      list.push(node);
      bySpecies.set(node.species, list);
    }
    const staged = new Map<string, BreedingNode>();

    for (const [parent1, gender1, parent2, gender2, child] of data.recipes) {
      const left = bySpecies.get(parent1);
      const right = bySpecies.get(parent2);
      if (!left || !right) continue;
      for (const a of left) {
        for (const b of right) {
          if (!compatibleParents(a, gender1, b, gender2)) continue;
          const childGeneration = Math.max(a.generation, b.generation) + 1;
          if (childGeneration !== generation) continue;
          add(
            {
              species: child,
              gender: "*",
              passiveMask: a.passiveMask | b.passiveMask,
              generation: childGeneration,
              breedCount: a.breedCount + b.breedCount + 1,
              parents: [a, b],
            },
            staged,
          );
        }
      }
    }
    for (const node of staged.values()) add(node);
  }

  const targetSpecies = canonicalSpecies(targetId, canonical);
  const fullMask = (1 << desiredPassives.length) - 1;
  const candidates = [...states.values()].filter(
    (node) => node.species === targetSpecies && node.passiveMask === fullMask,
  );
  candidates.sort((a, b) =>
    a.generation - b.generation || a.breedCount - b.breedCount || sourceScore(b) - sourceScore(a),
  );
  return { target: candidates[0] ?? null, reachableSpecies: new Set([...states.values()].map((n) => n.species)).size };
}

