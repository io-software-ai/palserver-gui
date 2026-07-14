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
| 新詞條（被動技） | `passives.json` |
| 新主動技 | `activeSkills.json` |
| 新地區 / 地圖重繪 | 地圖底圖 + `landmarks.json` + `bosses.json` + `ores.json`（見最後一節） |
| 新野外頭目（Alpha Pal） | `bosses.json`（見最後一節） |
| 新礦物 / 礦點變動 | `ores.json`：跑 `node scripts/fetch-map-ores.mjs`；新礦種要先在腳本的 `TYPES` 補「map_data type → items.json id」對照 |

## 資料檔清單與 schema

全部在 `packages/web/public/game-data/`。前端由 `packages/web/src/gameData.ts` 載入，
執行時還會背景比對 GitHub raw 上的最新版（所以只改名稱翻譯不用重新出版）。

| 檔案 | schema | 圖示資料夾 | 來源 |
|---|---|---|---|
| `pals.json` | `{id, name, icon?, zh?, zhCN?, ja?}` | `pals/` | paldb.cc / paldeck.cc |
| `items.json` | `{id, name, icon?, zh?, zhCN?, ja?}` | `items/` | paldb.cc |
| `passives.json` | `{id, name, zh?, zhCN?, ja?, rank}` | 無（前端畫箭頭） | paldb.cc + paldeck.cc |
| `activeSkills.json` | `{id, name, zh?, zhCN?, ja?, element?}` | 無 | paldb.cc + paldeck.cc |
| `landmarks.json` / `bosses.json` | `{name:{en, zh, zhCN?, ja}, x, y, ...}` | landmark-icons / pals | paldb.cc map data |
| `ores.json` | `{types:{key:{name, icon, color, big?}}, spots:[{t, x, y}]}` | items/（沿用物品圖示） | paldb.cc map data（`scripts/fetch-map-ores.mjs` 可重跑；礦物名稱/翻譯對接 items.json） |

`zh` 是繁中、`zhCN` 是簡中（介面選簡中時前端 `displayName` / MapTab 優先取 zhCN，缺則 fallback 繁中→英文）。

**關鍵原則**：`id` 是遊戲/PalDefender 內部 id（不是顯示名），是對接遊戲存檔與 REST 的鍵，
**絕不能改**。名稱翻譯（zh/ja）可以更新；`id` 一旦錯了，玩家資料就對不上。JSON 一律
compact 單行（`JSON.stringify(x) + "\n"`），欄位順序固定 `id, name, icon, zh, zhCN, ja, ...` 方便 diff。

抓取一律帶 User-Agent `palserver-gui-data-sync (maintainer-approved; github.com/io-software-ai/palserver-gui)`
（維護者已獲 paldb.cc 同意，見 `packages/web/public/game-data/CREDITS.md`），並禮貌節流。

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
  （i18n 版本換 `map_data_tw.js` / `map_data_ja.js`）。主陣列是 `var fixedDungeon = [...]`（~13000 筆,
  含各類 marker），每筆 `{id, lv?, type, item(顯示名), fixed_icon, ipos:{X,Y}}`。**`ipos.X`/`ipos.Y`
  就直接等於我們的地圖座標 x/y（已驗證,無需換算）**。
- **地標**：`packages/web/public/game-data/landmarks.json`，`{type, x, y, lv?, name:{en,zh,ja}}`。
  type 目前有 `Fast Travel` / `Tower` / `Dungeon`（對應 `fixedDungeon` 裡同名 type），各有專屬圖示在
  `game-data/landmark-icons/`。
- **野外頭目（Alpha Pal）**：`packages/web/public/game-data/bosses.json`，`{name:{en,zh,ja}, x, y, lv?, icon?}`。
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
4. **i18n 覆蓋率**：印出各檔 zh/ja 覆蓋率，明顯掉落就是解析壞了。抓不到的誠實留空，**不要**塞英文或 `-`。
5. **build 過**：`pnpm --filter @palserver/web exec vite build`。
6. **抽查渲染**：挑幾個新怕魯/物品，確認 name/zh/ja/icon 四欄都對。
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
- **補既有怕魯/物品譯名最穩的抓法**：`https://paldb.cc/tw/<英文顯示名>` 與 `/ja/<英文顯示名>` 頁的
  `<meta property="og:title">` 就是該語言顯示名（空白換底線，例 `/tw/Eidrolon`、`/ja/Azurobe_Cryst`）。
  新怕魯常「先有 id/en、後有譯名」——paldeck 還沒收的，paldb 通常已有頁 + og:title，用它填 zh/ja
  比索引頁 anchor 可靠（連變體頁都有）。物品內部 id 則到 `paldb.cc/en/<slug>` 抓第一個 `?s=Items%2F<id>`
  （顯示名 slug ≠ 內部 id，例 木板 `Wooden_Board` 的 id 是 `Processed_Wood`）。
