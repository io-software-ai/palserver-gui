# Game data credits

Pal and item catalogs (`pals.json`, `items.json`) and their icons are used to
label IDs in the UI (giving items/Pals, moderation lists, etc.).
Traditional Chinese, Simplified Chinese, and Japanese display names are stored
alongside English names when the source provides them.

- **Pal icons** (`pals/`): carried over from the v1 palserver-GUI assets.
- **Item icons** (`items/`): sourced from [paldb.cc](https://paldb.cc)'s CDN,
  fetched with permission (project maintainer is a paldb.cc contributor).
- **Passive-skill catalog** (`passives.json`): internal ids, names and ranks
  from [paldeck.cc](https://paldeck.cc) (project maintainer is a contributor).
  Passives have no unique in-game artwork — the UI draws the rank badge itself.
- **Active-skill catalog** (`activeSkills.json`): names from
  [paldb.cc](https://paldb.cc)'s `Active_Skills` index (`EPalWazaID`), elements
  joined from [paldeck.cc](https://paldeck.cc)'s skills data by internal id.
- **Human NPC catalog** (`humans.json` + `humans/` icons): internal ids, names
  and icons from [paldb.cc](https://paldb.cc)'s `Humans` index page (`en`/`tw`/
  `ja`/`cn`), which lists non-Pal characters (capturable human NPCs, Syndicate/
  cult/arena characters, etc.) under the shared `Pals` id namespace.
- **Guild Lab Research catalog** (`research.json`): labels the save file's
  `research_id` / `current_research_id` (Guild → Lab, the Feybreak-update "Pal
  Labor Research Laboratory" tech tree). paldb.cc's own
  [`Pal_Labor_Research_Laboratory`](https://paldb.cc/en/Pal_Labor_Research_Laboratory)
  page has **no internal ids** (unlike its Items/Pals/Humans indexes — no
  `data-hover` anchors at all, confirmed by inspection), and paldeck.cc has no
  research page. Internal ids + English/Traditional-Chinese/Simplified-Chinese
  names come from
  [`oMaN-Rod/palworld-save-pal`](https://github.com/oMaN-Rod/palworld-save-pal)
  (an actively maintained, Discord-backed Palworld save editor with a full lab
  research tree UI — its own frontend keys off these same ids to look up
  saves, which is corroborating evidence they match real save `research_id`
  values), specifically `data/json/lab_research.json` +
  `data/json/l10n/{en,zh-Hant,zh-Hans}/lab_research.json` (168/168 entries,
  full coverage). **Caveat**: that repo has no stated license (not the
  established paldb.cc/paldeck.cc "maintainer is a contributor" relationship
  this project otherwise relies on) — re-review before treating this as
  settled if that matters to you. Japanese names aren't available there (the
  repo has no `ja` locale for anything, not just this file) — `ja` is instead
  filled in from paldb.cc's `en`/`ja` `Pal_Labor_Research_Laboratory` pages by
  matching identical English display-name strings within the same category
  (not by page position, which does *not* line up between paldb and the
  `oMaN-Rod` id order — verified by inspection); one entry (`EmitFlame1_6`,
  "Kindling Lv6") has no `ja` because paldb's own list doesn't include that
  tier, and is left blank rather than guessed.
- **Player technology catalog** (`technologies.json`): technology ids,
  English, Traditional-Chinese, Simplified-Chinese, and Japanese names, and
  icon URLs are read directly from paldb.cc's four `/Technologies` pages. Icons
  already present in this project's `items/` catalog are reused; the remaining
  PalDB icons are stored in `technologies/`.

`passives.json` / `activeSkills.json` are regenerated with
`node scripts/fetch-skills-passives.mjs`. `humans.json` is regenerated with
`node scripts/fetch-human-npcs.mjs`. `research.json` is regenerated with
`node scripts/fetch-lab-research.mjs`. The player technology catalog and icons
are refreshed with `node scripts/fetch-game-data-i18n.mjs technologies`.

All Palworld artwork is © Pocketpair, Inc. These icons are bundled only to
label in-game entities within this management tool.

## Breeding data

`breeding.json` is a compact transform of the breeding database from
[`tylercamp/palcalc`](https://github.com/tylercamp/palcalc), Copyright 2024
Tyler Camp, used under the MIT License. It is regenerated with
`node scripts/fetch-palcalc-breeding.mjs`; the original copyright notice and
license are preserved in this repository's `THIRD_PARTY_LICENSES.md`.

## World Tree base map

`packages/web/public/worldtree-map.webp` is stitched from paldb.cc's World
Tree map tiles (`node scripts/fetch-worldtree-map.mjs`, maintainer-approved
scraping, same arrangement as the game-data name sync).
`worldtree-bosses.json` / `worldtree-landmarks.json` / `worldtree-ores.json`
come from paldb.cc's `treemap_data_{en,tw,cn,ja}.js` fixedDungeon array
(`node scripts/fetch-worldtree-mapdata.mjs`). Calibration bounds
come from paldb.cc's `treemap_data_en.js` (`landScapeRealPositionMin/Max`);
the coordinate transform lives in `packages/shared/src/index.ts`
(`savToWorldTreeMap`). Map artwork is © Pocketpair, Inc.
