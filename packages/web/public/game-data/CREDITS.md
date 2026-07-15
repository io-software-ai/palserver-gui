# Game data credits

Pal and item catalogs (`pals.json`, `items.json`) and their icons are used to
label IDs in the UI (giving items/Pals, moderation lists, etc.).

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

`passives.json` / `activeSkills.json` are regenerated with
`node scripts/fetch-skills-passives.mjs`. `humans.json` is regenerated with
`node scripts/fetch-human-npcs.mjs`.

All Palworld artwork is © Pocketpair, Inc. These icons are bundled only to
label in-game entities within this management tool.
