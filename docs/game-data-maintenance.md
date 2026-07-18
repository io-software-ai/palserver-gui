# 遊戲資料維護指南（Palworld 改版時要做的事）

> 給未來維護者 / AI session 看。Palworld 每次改版（新地區、新怕魯、新物品、新詞條/技能）
> 之後，這份專案內嵌的靜態遊戲資料就會過時，要照這份更新。上一次大更新是
> **1.0 / 屋久島（Yakushima）**，把 items 1585→2185、pals 187→290。

## 什麼時候要更新

遊戲有以下任一情況就要更新對應資料：

| 遊戲變動 | 要更新的資料 |
|---|---|
| 新怕魯、新怕魯屬性變體 | `pals.json` + `pals/` 圖示 |
| 新物品、新武器、新道具 | `items.json` + `items/` 圖示 |
| 新科技或科技樹調整 | `technologies.json` + `technologies/` 圖示 |
| 新詞條（被動技） | `passives.json` |
| 新主動技 | `activeSkills.json` |
| 公會 Lab Research 新增/改動研究項目 | `research.json`（見「更新公會研究目錄」一節） |
| 新地區 / 地圖重繪 | 地圖底圖 + `landmarks.json` + `bosses.json` + `ores.json`（見最後一節） |
| 新野外頭目（Alpha Pal） | `bosses.json`（見最後一節） |
| 新礦物 / 礦點變動 | `ores.json`：跑 `node scripts/fetch-map-ores.mjs`；新礦種要先在腳本的 `TYPES` 補「map_data type → items.json id」對照 |
| 世界樹圖層(Alpha/地標/樹晶礦)變動 | 跑 `node scripts/fetch-worldtree-mapdata.mjs` 重生 `worldtree-{bosses,landmarks,ores}.json` |
| 世界樹底圖更新 | `packages/web/public/worldtree-map.webp`：跑 `node scripts/fetch-worldtree-map.mjs`(需 website/node_modules 的 sharp)。座標邊界若變(paldb treemap_data 的 landScapeRealPositionMin/Max),同步改 `packages/shared/src/index.ts` 的 `WORLD_TREE_BOUNDS` 並跑 `worldtree.test.ts` |

## 資料檔清單與 schema

全部在 `packages/web/public/game-data/`。前端由 `packages/web/src/gameData.ts` 載入，
執行時還會背景比對 GitHub raw 上的最新版（所以只改名稱翻譯不用重新出版）。

| 檔案 | schema | 圖示資料夾 | 來源 |
|---|---|---|---|
| `pals.json` | `{id, name, icon?, zh?, "zh-CN"?, zhCN?, ja?}` | `pals/` | paldb.cc / paldeck.cc |
| `items.json` | `{id, name, icon?, zh?, "zh-CN"?, zhCN?, ja?}` | `items/` | paldb.cc |
| `technologies.json` | `{id, name, icon?, zh?, "zh-CN"?, zhCN?, ja?}` | `items/`（同名圖示）+ `technologies/` | paldb.cc `/Technologies` 四語頁 |
| `passives.json` | `{id, name, zh?, "zh-CN"?, zhCN?, ja?, rank}` | 無（前端畫箭頭） | paldb.cc + paldeck.cc |
| `activeSkills.json` | `{id, name, zh?, "zh-CN"?, zhCN?, ja?, element?}` | 無 | paldb.cc + paldeck.cc |
| `humans.json` | `{id, name, icon?, zh?, ja?, zhCN?}` | `humans/` | paldb.cc `/Humans` 索引頁 |
| `research.json` | `{id, name, zh?, zhCN?, ja?}` | 無 | oMaN-Rod/palworld-save-pal（id + en/zh/zhCN）+ paldb.cc（ja，同名比對，見下方專節） |
| `landmarks.json` / `bosses.json` | `{name:{en, zh, "zh-CN"?, zhCN?, ja}, x, y, ...}` | landmark-icons / pals | paldb.cc map data |
| `ores.json` | `{types:{key:{name, icon, color, big?}}, spots:[{t, x, y}]}` | items/（沿用物品圖示） | paldb.cc map data（`scripts/fetch-map-ores.mjs` 可重跑；礦物名稱/翻譯對接 items.json） |

`zh` 是繁中；`"zh-CN"` 是人工校對的簡中，顯示時優先；`zhCN` 是上游抓取的簡中後備。
兩者都缺時才 fallback 繁中→英文，避免遠端資料更新覆蓋已校對譯名。

**關鍵原則**：`id` 是遊戲/PalDefender 內部 id（不是顯示名），是對接遊戲存檔與 REST 的鍵，
**絕不能改**。名稱翻譯（zh/ja）可以更新；`id` 一旦錯了，玩家資料就對不上。JSON 一律
compact 單行（`JSON.stringify(x) + "\n"`），欄位順序固定 `id, name, icon, zh, "zh-CN", zhCN, ja, ...` 方便 diff。

抓取一律帶 User-Agent `palserver-gui-data-sync (maintainer-approved; github.com/io-software-ai/palserver-gui)`
（維護者已獲 paldb.cc 同意，見 `packages/web/public/game-data/CREDITS.md`），並禮貌節流。

---

## 更新玩家科技目錄（technologies.json）

科技目錄是從 PalDB 整份重建，直接執行：

```
node scripts/fetch-game-data-i18n.mjs technologies
```

腳本依序抓 `/en/Technologies`、`/tw/Technologies`、`/cn/Technologies`、
`/ja/Technologies`，使用每張卡片的 `Technology/<id>` 對齊四語名稱，並以英文頁的
`background-image` 取得圖示。與 `items/` 同 basename 的圖示直接復用，其餘下載到
`technologies/`；PalDB 科技卡片暫時缺圖時，才按相同 ID 復用 `items.json` 的圖示。
四語頁數量不一致時腳本會中止，不會寫出不完整目錄。既有人工校對的 `"zh-CN"`
欄位會保留，PalDB `/cn/` 名稱寫入 `zhCN`。

---

## 更新怕魯 / 物品（pals.json / items.json）

這兩個**只能新增、不能覆蓋既有條目**（既有的英文名有人工修正過、既有 id 對接玩家資料）。
流程是「爬新條目 → 只合併差集 → 下載圖示」。

### 1. 爬取「新條目」

- **物品完整清單**：`https://paldb.cc/en/Items` 是 server-render 的**完整**清單（上次 1850 筆）。
  每張卡片有 `data-hover="?s=Items%2F<id>"`（抓 id）與 `<img src="https://cdn.paldb.cc/image/...">`（抓 icon URL）。
  三語名稱：`/en/Items`、`/tw/Items`、`/ja/Items` 三頁，同一 id 對接。
- **怕魯完整清單**：⚠️ `https://paldb.cc/en/Pals` 只 server-render 前 ~120 筆（**不完整**，且不是單純前 N 筆）。
  改用 **`https://paldeck.cc/pals`**（Next.js，資料在 `self.__next_f.push([n,"..."])` 串流片段；
  用 `scripts/fetch-skills-passives.mjs` 裡的 `nextFlight()` 手法拼回，再正則抓
  `"name":...,"asset_name":...,"icon":...`）——上次解析出 290 筆，含屋久島新怪。
- 每筆輸出 `{id, name, zh?, ja?, icon, iconUrl}`，`icon`=iconUrl 的 basename，只留「既有 JSON 沒有的 id」。

### 2. 合併 + 下載圖示

用 `scripts/merge-new-catalog-entries.mjs`（讀一份 new-entries JSON，只 append 差集、下載
`iconUrl` 到對應資料夾；**下載失敗就拿掉該筆的 icon 欄**，避免破圖）。

```
node scripts/merge-new-catalog-entries.mjs items <new-items.json>
node scripts/merge-new-catalog-entries.mjs pals  <new-pals.json>
```

- 怕魯圖示 host：`https://cdn.paldb.cc/image/Pal/Texture/PalIcon/Normal/<basename>`。
- 物品圖示 host：`https://cdn.paldb.cc/image/Others/InventoryItemIcon/Texture/<basename>` 或卡片 `<img src>`。
- 少數新條目 paldb 不提供圖（cdn 回 403）→ 腳本會自動略過 icon 欄，該筆無圖但仍可用。

---

## 更新詞條 / 主動技（passives.json / activeSkills.json）

這兩個是**從來源整份重建**（沒有人工精修要保護），直接跑：

```
node scripts/fetch-skills-passives.mjs
```

它會抓 paldb.cc `/en /tw /ja` 的 `Active_Skills`（用 `EPalWazaID::<id>` anchor 對接三語，可靠）
與 paldeck.cc 的 passives/skills（英文名、rank、element）。已知限制：

- **詞條 zh 是「用 rank 順序位置對齊」**（paldb 詞條頁沒有 per-entry id）——每次重跑要確認
  paldb en/tw 詞條清單筆數與順序一致，否則會整段錯位。
- **詞條 ja 目前抓不到**：paldb ja 詞條頁筆數落後（上次只有 102/114），位置對齊會誤植，故留空。
  若之後 paldb ja 補齊到與 en 同筆同序，可在腳本裡打開 ja 位置對齊。
- 新版剛出時，個別新詞條 paldb 還沒收錄（上次 `MiniNushi/Whopper` 缺 zh）——正常，之後重跑會補上。

---

## 更新人類 NPC 目錄（humans.json）

玩家詳情頁要標示存檔裡「用帕魯球抓到的人類 NPC」（CharacterID 如 `Hunter_Bat`、
`Male_People02`）的名稱與圖示，這些角色不在 `pals.json`（不是怕魯），改用
`humans.json`。這份也是**從來源整份重建**，直接跑：

```
node scripts/fetch-human-npcs.mjs
```

它抓 `paldb.cc/{en,tw,ja,cn}/Humans` 索引頁——paldb 把所有非怕魯角色（人類 NPC、
Syndicate/邪教/競技場角色等）都歸在這頁，id 仍在 `Pals` namespace 下，四語言版本
用內部 id 直接對接（可靠，不必位置對應）。共用同一張佔位圖
`T_character_common_human_00.webp` 的條目視同「無專屬圖示」，icon 留空交給前端
通用人形 fallback。多個 id 共用同一張圖示檔（例如各種 `Hunter_*` 變體）屬正常，
反映遊戲內角色共用模型的事實。

---

## 更新公會研究目錄（research.json）

公會頁要標示存檔 `GuildExtraSaveDataMap → Lab → research_info.values[].research_id` /
`current_research_id`（見 `packages/agent/src/save-health.ts`）——這是 Feybreak 改版
加入的「公會研究（Pal Labor Research Laboratory）」科技樹，168 個研究項目分 9 大類
（Handiwork/Kindling/Watering/Planting/Generating Electricity/Lumbering/Mining/
Cooling/Medicine Production）。這份**跟其他 game-data 檔案的來源管線不一樣**，重跑前
務必先看完這節，不要照抄 items/pals 那套。

```
node scripts/fetch-lab-research.mjs
```

**來源特殊之處**：

- paldb.cc 的 `/{en,ja}/Pal_Labor_Research_Laboratory` 頁**沒有內部 id**——跟
  Items/Pals/Humans 索引頁不同，這頁完全沒有 `data-hover="?s=..."` 這類 anchor
  （已用 curl 實測確認），只有「顯示名稱 + 需求等級」的敘述卡片。paldeck.cc 也沒有
  研究相關頁面。
- 內部 id（如 `EmitFlame1`、`Cool3_2`）+ en/zh（繁）/zhCN（簡）名稱改抓
  **`oMaN-Rod/palworld-save-pal`**（一款有 Discord 社群、持續維護的存檔編輯器）
  GitHub repo 的 `data/json/lab_research.json` +
  `data/json/l10n/{en,zh-Hant,zh-Hans}/lab_research.json`，168/168 筆全覆蓋。
  該專案前端 `labResearch.svelte.ts` 直接拿這些 id 去對存檔查表，佐證這批 id 就是
  真實存檔的 `research_id` 值。**這個 repo 沒有標示授權**——不是 paldb.cc/paldeck.cc
  那種本專案維護者已取得許可的關係，commit 前自行評估是否要保留這個來源（見
  `CREDITS.md` 的完整說明）。
- **ja 沒有官方來源可以直接對接**：`oMaN-Rod` repo 完全不支援日文（整個專案所有
  語言檔都沒有 `ja`）。改用「同名比對」從 paldb.cc 補：paldb 的 en/ja 頁是同一份
  資料庫渲染出的兩個語言版本，168 張卡片彼此逐一對應（同站同頁面結構的跨語言對接
  可靠），但 **paldb 卡片的頁面呈現順序跟 `oMaN-Rod` 的 id 順序對不上**（例如
  paldb 把「Flame Cauldron Development」排在 Kindling 分類第 3 張，`oMaN-Rod`
  卻排在該分類最後一筆）——所以**不能位置對齊**，腳本改成：先把兩邊都依「分類」
  分組（分類名稱與筆數已核對過一一對應，見腳本內 `CATEGORY_MAP`），組內用
  「英文顯示名字串完全相同」鎖定同一張卡，才取該卡的 ja 名稱。上次跑出
  167/168（只有 `EmitFlame1_6`「Kindling Lv6」paldb 清單沒收錄，留空，不硬湊）。
- 若之後 paldb 改版導致 `CATEGORY_MAP` 的分類名稱或筆數對不上，腳本會印出警告；
  重新核對「paldb 分類名稱 → `oMaN-Rod` category 欄位」與筆數即可修正。
- 無圖示：paldb 研究頁的圖示是「效果類型」共用圖（例如 `CraftSpeed_00` 給同分類多個
  等級共用），不是每個研究項目專屬美術，比照 `passives.json` 不下載圖示。

---

## 更新帕魯原版數值（pal-stats-defaults.json）

帕魯數值編輯器的 placeholder / row 名大小寫校正 / 變體存在性判斷都吃這份。

```bash
node scripts/fetch-pal-stats-defaults.mjs
```

- 來源：paldb.cc（`/en/Pals` 索引枚舉一般種頁 → 每頁「Tribes」卡跟進變體頁）。
  頁面的「Code」欄位是權威 RowName——**大小寫以它為準**（`BOSS_` 大寫為主流、
  `Boss_Anubis` 是唯一混用例外），不要手改。
- 欄位標籤對照（三個不同名）：Health→`Hp`、Attack→`ShotAttack`、Work Speed→`CraftSpeed`；
  同名標籤取第一次出現（第二次是等級縮放後的範圍值）。
- 驗證：腳本輸出的「row 數」應在 650 上下、「前綴分佈」的 normal 與 BOSS_ 應各約 300；
  抽 `Anubis`（Hp 120）與 `Boss_Anubis`（Hp 144、CaptureRateCorrect 0.7）對照 paldb 頁面。

---

## 更新地圖（底圖 + 地標）

地圖在 `packages/web/src/MapTab.tsx`，用 Leaflet `CRS.Simple` 把一張大底圖鋪成座標系。

- **底圖**：`packages/web/public/palworld-full-map.jpg`。上次是從 palworld.gg 的 raster tiles
  （`/images/tiles/{z}/{x}/{y}.png`，zoom 0–6）用 jimp 拼接成 zoom-4（4096²）JPG。要更高解析度就拼 zoom-5。
  換底圖後**必須重算 `IMAGE_BOUNDS`**（`MapTab.tsx:40`）：它是「世界座標邊界」經 `savToMap()`
  換算成地圖座標的結果。世界邊界（palworld.gg 反推）X∈[-1099400, 349400]、Y∈[-724400, 724400]。
  新地區若擴大了世界邊界，這兩組數字都要跟著改，否則地標會偏移。
- **座標換算**：`savToMap(worldX, worldY)`（存檔世界座標 → 遊戲內地圖座標），marker 放在
  `L.latLng(mapY, mapX)`。paldb.cc 的 `ipos` 就等於 `savToMap` 的輸出（已用「起始之丘」校準）。
- **地標與野外頭目的資料源**：paldb.cc 的地圖 marker 資料檔 **`https://paldb.cc/js/map_data_en.js`**
  （i18n 版本換 `map_data_tw.js` / `map_data_cn.js` / `map_data_ja.js`）。主陣列是 `var fixedDungeon = [...]`（~13000 筆,
  含各類 marker），每筆 `{id, lv?, type, item(顯示名), fixed_icon, ipos:{X,Y}}`。**`ipos.X`/`ipos.Y`
  就直接等於我們的地圖座標 x/y（已驗證,無需換算）**。
- **地標**：`packages/web/public/game-data/landmarks.json`，`{type, x, y, lv?, name:{en,zh,zh-CN,ja}}`。
  type 目前有 `Fast Travel` / `Tower` / `Dungeon`（對應 `fixedDungeon` 裡同名 type），各有專屬圖示在
  `game-data/landmark-icons/`。
- **野外頭目（Alpha Pal）**：`packages/web/public/game-data/bosses.json`，`{name:{en,zh,zh-CN,ja}, x, y, lv?, icon?}`。
  取 `fixedDungeon` 裡 `type==="Alpha Pal"` 的 marker（上次 83 筆）。boss `id` = `BOSS_<palId>`,
  **去掉 `BOSS_` 前綴就對得上 `pals.json`**——名稱 zh/ja 與圖示（帕魯肖像,已在 `pals/`）都從 pals.json 取,
  少數對不上的 boss 才用 map_data 的 `item`/`fixed_icon` 兜底（缺的圖示從 cdn.paldb.cc 補下）。
- 地標與野外頭目都是**贊助者限定**功能（與公會據點同層 gating），改資料不影響 gating。
- **公會據點圖示**用遊戲素材 `landmark-icons/palbox.webp`（帕魯方舟 `T_icon_buildObject_PalBoxV2`），
  放在公會色外框上;boss 圖示是帕魯肖像+紅框+皇冠,與玩家頭像刻意做得不同。

---

## 收尾前的驗證清單（每次更新都要跑）

1. **JSON 合法**：每個改過的檔案 `JSON.parse` 過。
2. **圖示都在**：每個有 `icon` 欄的條目，對應圖檔存在於資料夾（掃一次 `access()`，missing 應為 0）。
3. **既有資料沒被動到**：pals/items 更新後，既有 id 全數還在、名稱沒被覆蓋（`git diff` 只該有新增）。
4. **i18n 覆蓋率**：印出各檔 zh/zh-CN/ja 覆蓋率，明顯掉落就是解析壞了。抓不到的誠實留空，**不要**塞英文或 `-`。
5. **build 過**：`pnpm --filter @palserver/web exec vite build`。
6. **抽查渲染**：挑幾個新怕魯/物品，確認 name/zh/zh-CN/ja/icon 五欄都對。
7. commit 時**只加自己動到的檔**（使用者常同時在改別的檔案，用明確路徑 `git add`，別 `git add -A`）。

## 補簡體中文 zhCN 欄位

`zhCN` 是簡中顯示名。paldb.cc 的 `/cn/` 是**獨立維護的簡中版**（不是 `/tw/` 繁轉簡，部分譯名用詞不同），
所以優先抓官方簡中，抓不到才用繁轉簡 fallback。

1. **抓官方簡中**：`node scripts/fetch-zh-cn.mjs`——比照 `fetch-game-data-i18n.mjs`，把站點換 `/cn/`：
   pals/items 靠 `?s=<Kind>%2F<id>` anchor 對接；activeSkills 靠 `EPalWazaID::<id>`；
   passives 靠 en/cn 卡片位置對齊；landmarks/bosses 靠 `js/map_data_cn.js` 的 `ipos` 座標比對。
   只新增 `zhCN`，不覆蓋既有欄位。
2. **繁轉簡 fallback**：`/cn/` 抓不到對應的個別條目，用 OpenCC 純字轉（`from:'t', to:'cn'`）從 `zh` 補，
   避免詞彙誤替換（遊戲專名）。無名條目（如無名地牢 name 各語言皆空）保持空白、不硬補。
3. 收尾同下方驗證清單：確認每個「有名字」的條目都有非空 `zhCN`（無名地牢的空 `zhCN` 屬正常）。

## 踩坑筆記（別重踩）

- paldb.cc 改版後，舊 `fetch-game-data-i18n.mjs` 的 `<a class="itemname" data-hover="?s=...">` 名稱正則
  在**詳細頁**失效（data-hover 變 `/cache/<lang>/..._hover/<hash>`，href 變顯示名 slug）。
  **索引頁**的 `?s=<Kind>%2F<id>` anchor 仍有效——抓 id 用它。
- 怕魯索引頁不完整（只 120），完整清單走 paldeck.cc/pals，別浪費時間在 paldb 分頁上。
- 圖示偶爾 403，別讓整批中斷；缺圖的條目留著、拿掉 icon 欄即可。
- 詞條沒有可靠的多語 id 對接來源，zh 只能位置對齊、ja 拿不到——這是來源限制，不是你的 bug。
- **補既有怕魯/物品譯名最穩的抓法**：`https://paldb.cc/tw/<英文顯示名>`、`/cn/<英文顯示名>` 與 `/ja/<英文顯示名>` 頁的
  `<meta property="og:title">` 就是該語言顯示名（空白換底線，例 `/tw/Eidrolon`、`/ja/Azurobe_Cryst`）。
  新怕魯常「先有 id/en、後有譯名」——paldeck 還沒收的，paldb 通常已有頁 + og:title，用它填 zh/ja
  比索引頁 anchor 可靠（連變體頁都有）。物品內部 id 則到 `paldb.cc/en/<slug>` 抓第一個 `?s=Items%2F<id>`
  （顯示名 slug ≠ 內部 id，例 木板 `Wooden_Board` 的 id 是 `Processed_Wood`）。
- **公會研究（research.json）沒有內部 id 可抓的索引頁**：paldb.cc 的
  `Pal_Labor_Research_Laboratory` 頁只有敘述卡片、無 `data-hover` anchor，跟其他
  paldb 索引頁的結構完全不同——別再花時間找這頁的 id anchor，改走
  `oMaN-Rod/palworld-save-pal` GitHub repo（見「更新公會研究目錄」一節）。
- **research.json 的 ja 是「同名比對」不是「位置比對」**：paldb 的卡片頁面順序跟
  `oMaN-Rod` 的 id 順序不一致（同分類內排序依據不同），直接位置對齊會整批錯位；
  一律先用英文顯示名字串鎖定同一張卡再取 ja，對不上就留空。

## breeding.json(配種配方表)

- 位置:`packages/web/public/game-data/breeding.json`(來源:[tylercamp/palcalc](https://github.com/tylercamp/palcalc),MIT)
- 遊戲改版新增帕魯後,等 PalCalc 上游更新,再跑 `node scripts/fetch-palcalc-breeding.mjs` 重新生成。
- 注意:配種目標選單同時依賴 `pals.json` 的物種名稱/圖示——PalCalc 領先本地資料時,新物種會缺名稱且無法選為目標,兩者要一起更新。
