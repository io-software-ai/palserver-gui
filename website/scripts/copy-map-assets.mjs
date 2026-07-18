#!/usr/bin/env node
// /map viewer 頁需要的底圖/地標/礦物素材,單一素材來源是 packages/web/public(GUI 本體也
// 用同一份)。這支腳本在 dev/build 前(見 package.json 的 predev/prebuild)把需要的檔案複製到
// website/public/map-assets/ —— 該目錄現在直接進 git(見 website/.gitignore 的說明:實測
// Zeabur 建置環境拿不到 sibling packages/,素材缺了就得先 commit),所以 packages/web 的
// 底圖/地標/礦物更新後,記得在本機重跑這支腳本並把 website/public/map-assets/ 的變動一併
// commit。
//
// 為什麼不讓 Next.js 直接讀 ../packages/web/public:App Router 靜態匯出只會打包
// public/ 底下的檔案,跨套件路徑無法被 next build 收進 out/,所以用複製而非引用。
//
// 若 build 環境沒有 sibling packages/ 目錄,這支腳本會印警告後直接結束(exit 0),不讓
// 行銷首頁的 build 因此失敗 —— 代價是本機忘記重跑時,/map 頁會用 git 裡的舊素材。
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../../packages/web/public');
const DEST_ROOT = path.resolve(__dirname, '../public/map-assets');

/** [來源(相對 packages/web/public), 目的地(相對 map-assets/)] */
const FILES = [
  ['palworld-full-map.jpg', 'palworld-full-map.jpg'],
  ['worldtree-map.webp', 'worldtree-map.webp'],
  ['game-data/landmarks.json', 'landmarks.json'],
  ['game-data/worldtree-landmarks.json', 'worldtree-landmarks.json'],
  ['game-data/landmark-icons/fasttravel.png', 'landmark-icons/fasttravel.png'],
  ['game-data/landmark-icons/tower.png', 'landmark-icons/tower.png'],
  ['game-data/landmark-icons/palbox.webp', 'landmark-icons/palbox.webp'],
  ['game-data/ores.json', 'ores.json'],
  ['game-data/worldtree-ores.json', 'worldtree-ores.json'],
];

if (!existsSync(SRC_ROOT)) {
  console.warn(
    `[copy-map-assets] 找不到 ${SRC_ROOT} —— 這個環境沒有 monorepo 的 packages/,略過複製。\n` +
      '[copy-map-assets] /map 頁的底圖/地標會缺檔;其餘頁面不受影響。',
  );
  process.exit(0);
}

let ok = 0;
for (const [rel, destRel] of FILES) {
  const from = path.join(SRC_ROOT, rel);
  const to = path.join(DEST_ROOT, destRel);
  if (!existsSync(from)) {
    console.warn(`[copy-map-assets] 缺檔,略過: ${rel}`);
    continue;
  }
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  ok++;
}
console.log(`[copy-map-assets] 複製 ${ok}/${FILES.length} 個檔案到 ${DEST_ROOT}`);
