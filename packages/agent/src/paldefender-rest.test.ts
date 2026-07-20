import assert from "node:assert/strict";
import test from "node:test";
import { readPalIvs } from "./paldefender-rest.js";

test("reads PalDefender camel-case Talent IV aliases", () => {
  assert.deepEqual(readPalIvs({
    TalentHp: 81,
    TalentMelee: 62,
    TalentShot: 73,
  }), {
    hp: 81,
    attack: 73,
    defense: undefined,
  });
});

test("prefers canonical PalDefender Talent fields over aliases", () => {
  assert.deepEqual(readPalIvs({
    Talent_HP: 91,
    TalentHp: 81,
    Talent_Shot: 93,
    TalentShot: 73,
    Talent_Defense: 95,
  }), {
    hp: 91,
    attack: 93,
    defense: 95,
  });
});
