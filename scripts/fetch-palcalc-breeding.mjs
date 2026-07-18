import fs from "node:fs/promises";
import path from "node:path";

const base = "https://raw.githubusercontent.com/tylercamp/palcalc/main/PalCalc.Model";
const out = path.resolve("packages/web/public/game-data/breeding.json");
const sourceDir = process.argv[2] ? path.resolve(process.argv[2], "PalCalc.Model") : null;

async function json(name) {
  if (sourceDir) return JSON.parse(await fs.readFile(path.join(sourceDir, name), "utf8"));
  const response = await fetch(`${base}/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

const [breeding, db] = await Promise.all([json("breeding.json"), json("db.json")]);
const gender = { WILDCARD: "*", MALE: "m", FEMALE: "f" };
const recipes = breeding.Breeding.map((row) => [
  row.Parent1InternalName,
  gender[row.Parent1Gender],
  row.Parent2InternalName,
  gender[row.Parent2Gender],
  row.ChildInternalName,
]);

await fs.writeFile(
  out,
  JSON.stringify({
    source: "tylercamp/palcalc",
    license: "MIT",
    version: db.Version,
    recipes,
  }),
);
console.log(`Wrote ${recipes.length} PalCalc recipes (${db.Version}) to ${out}`);
