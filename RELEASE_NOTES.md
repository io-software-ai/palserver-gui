# palserver GUI — v2.8.0

修復為主的一版:內建的 UE4SS 模組載入器改用 **Palworld 專用版**,大幅減少模組相關的伺服器閃退;根治「停服後殘留 PalServer 進程鎖住檔案、擋住模組更新」的老問題;頭目回報模組多項修復並改為可獨立更新的遠端交付。另含伺服器端資料夾瀏覽、捕捉輔助配種、ARM64 Docker 等。
A fix-focused release: the bundled UE4SS mod loader now uses the **Palworld-specific build**, greatly cutting mod-related server crashes; the long-standing "PalServer process not fully stopped" issue that locked files and blocked mod updates is fixed at the root; plus several boss-reporter fixes, now delivered remotely for independent updates. Also adds a server-side folder browser, capture-assisted breeding, ARM64 Docker, and more.
修正中心のリリース:内蔵 UE4SS ローダーを **Palworld 専用ビルド**に変更し MOD 関連のクラッシュを大幅削減。停止後も残る PalServer プロセスがファイルをロックして MOD 更新を妨げる長年の問題を根本修正。ボスレポーターの複数修正(独立更新できるリモート配信化を含む)。サーバー側フォルダーブラウザ、捕獲補助の交配、ARM64 Docker なども追加。

> 有開自動更新會自己抓,或依下方手動下載。
> The in-app updater fetches it automatically, or download below.
> 自動更新で取得、または下記から手動でダウンロード。

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### 重點修復
- **模組閃退修復 — UE4SS 改用 Palworld 專用版**:內建的 UE4SS 模組載入器改為 Palworld 專用的 Okaetsu(`experimental-palworld`)版本,相容性更好,大幅減少模組相關的伺服器閃退。UE4SS 現在也標得出版本(以建置日期),Okaetsu 更新建置時分頁會顯示「有新版」。
- **停止伺服器可靠關閉(根治老問題)**:舊版遺留、沒真正關掉的殭屍 PalServer 進程會鎖住 `dwmapi.dll` 等檔案,導致之後的模組更新/重灌**一直卡住**。改用更可靠的行程列舉(`Win32_Process`),停服時確實清掉殘留進程、釋放檔案鎖。
- **頭目回報模組(boss-reporter)修復**:
  - 地下城掃描的當機路徑修復。
  - 野外頭目一律顯示「約下個遊戲日重生」,不再算出離譜的倒數(例如剛擊殺卻顯示 22 小時)。
  - **改為遠端交付**:模組原始碼獨立管理,修 mod 不必等 GUI 改版;分頁顯示「有新版」可一鍵更新。
- **模組安裝卡住時給明確提示**:下載/安裝超過 10 秒會跳黃色警告,指引你多半是殭屍進程佔用檔案,重開機(推薦)或到工作管理員結束殘留的 PalServer 後再試。

### 新功能與改進
- **伺服器端資料夾瀏覽器**:建立實例時可直接瀏覽、選擇伺服器安裝路徑(也放行 Tailscale 等 VPN 網段,方便遠端管理)。
- **捕捉輔助配種**:配種計算器在現有帕魯湊不出目標時,改為建議該捕捉哪些帕魯;並把公會據點的工作帕魯納入,顯示帕魯倉庫/據點位置。
- **遠距傳送更穩**:傳送分兩階段提高成功率;廣播(broadcast)改走 REST API 以支援中文。
- **ARM64 Docker 化**:新增 ARM64 主機用 FEX 模擬跑伺服器的 Docker 映像。
- 自訂帕魯濃縮數量可依星等快速填入;新增物品「發光的古代文明遺物」。
- 限速地區可用鏡像 URL 安裝模組(繞過 GitHub 下載 CDN)。

</details>

<details>
<summary><b>🇨🇳 简体中文</b></summary>

### 重点修复
- **模组闪退修复 — UE4SS 改用 Palworld 专用版**:内置的 UE4SS 模组加载器改为 Palworld 专用的 Okaetsu(`experimental-palworld`)版本,兼容性更好,大幅减少模组相关的服务器闪退。UE4SS 现在也能标出版本(以构建日期),Okaetsu 更新构建时分页会显示「有新版」。
- **停止服务器可靠关闭(根治老问题)**:旧版遗留、没真正关掉的僵尸 PalServer 进程会锁住 `dwmapi.dll` 等文件,导致之后的模组更新/重装**一直卡住**。改用更可靠的进程枚举(`Win32_Process`),停服时确实清掉残留进程、释放文件锁。
- **头目汇报模组(boss-reporter)修复**:
  - 地下城扫描的崩溃路径修复。
  - 野外头目一律显示「约下个游戏日重生」,不再算出离谱倒数(例如刚击杀却显示 22 小时)。
  - **改为远端交付**:模组源码独立管理,修 mod 不必等 GUI 改版;分页显示「有新版」可一键更新。
- **模组安装卡住时给明确提示**:下载/安装超过 10 秒会弹黄色警告,提示多半是僵尸进程占用文件,重启电脑(推荐)或到任务管理器结束残留的 PalServer 后再试。

### 新功能与改进
- **服务器端文件夹浏览器**:创建实例时可直接浏览、选择服务器安装路径(也放行 Tailscale 等 VPN 网段,便于远程管理)。
- **捕捉辅助配种**:配种计算器在现有帕鲁凑不出目标时,改为建议该捕捉哪些帕鲁;并把公会据点的工作帕鲁纳入,显示帕鲁仓库/据点位置。
- **远距传送更稳**:传送分两阶段提高成功率;广播(broadcast)改走 REST API 以支持中文。
- **ARM64 Docker 化**:新增 ARM64 主机用 FEX 模拟跑服务器的 Docker 镜像。
- 自定义帕鲁浓缩数量可按星级快速填入;新增物品「发光的古代文明遗物」。
- 限速地区可用镜像 URL 安装模组(绕过 GitHub 下载 CDN)。

</details>

<details>
<summary><b>🇺🇸 English</b></summary>

### Key fixes
- **Mod-crash fix — UE4SS now uses the Palworld-specific build**: the bundled UE4SS mod loader now uses Okaetsu's Palworld build (`experimental-palworld`), which is far more compatible and greatly reduces mod-related server crashes. UE4SS now also reports a version (by build date), and the tab shows "update available" when Okaetsu ships a new build.
- **Reliable server stop (long-standing fix)**: a zombie PalServer process left over from an old version could keep holding files like `dwmapi.dll`, making later mod updates/reinstalls **hang forever**. Stop now uses a more reliable process enumeration (`Win32_Process`) to actually clear leftover processes and release the file locks.
- **Boss-reporter fixes**:
  - Fixed a crash path in the dungeon scan.
  - Wild bosses now always show "respawns around the next in-game day" instead of a nonsensical countdown (e.g. 22 hours right after a kill).
  - **Now delivered remotely**: the mod's source is managed independently, so fixes ship without waiting for a GUI update; the tab shows "update available" for one-click updates.
- **Clear prompt when an install hangs**: if a download/install exceeds 10 seconds, a yellow warning explains it's usually a zombie process holding files — restart the PC (recommended) or end the leftover PalServer in Task Manager, then retry.

### New features & improvements
- **Server-side folder browser**: pick the server install path by browsing when creating an instance (Tailscale/VPN ranges are allowed too, for remote management).
- **Capture-assisted breeding**: when your owned Pals can't reach the target, the calculator now suggests which Pals to capture, and includes guild-base worker Pals with palbox/base locations.
- **Steadier remote teleport**: two-stage teleport for higher success; broadcast now goes through the REST API to support non-ASCII text.
- **ARM64 Docker**: a new Docker image runs the server on ARM64 hosts via FEX emulation.
- Condenser counts for custom Pals can be quick-filled by star rank; new item "Glowing Relic of Ancient Civilization".
- Throttled regions can install mods via a mirror URL (bypassing GitHub's download CDN).

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### 主な修正
- **MOD クラッシュ修正 — UE4SS を Palworld 専用ビルドに変更**:内蔵の UE4SS ローダーを Okaetsu の Palworld ビルド(`experimental-palworld`)に変更しました。互換性が高く、MOD 関連のサーバークラッシュを大幅に削減します。UE4SS はビルド日でバージョンを表示するようになり、Okaetsu が新ビルドを公開するとタブに「新バージョンあり」が表示されます。
- **停止の確実化(長年の修正)**:古いバージョンから残った、正しく終了していないゾンビ PalServer プロセスが `dwmapi.dll` などのファイルを掴んだままになり、その後の MOD 更新/再インストールが**止まってしまう**ことがありました。停止処理をより確実なプロセス列挙(`Win32_Process`)に変更し、残留プロセスを確実に終了させてファイルロックを解放します。
- **ボスレポーター MOD の修正**:
  - ダンジョンスキャンのクラッシュ経路を修正。
  - フィールドボスは常に「翌ゲーム内日ごろにリスポーン」と表示し、不自然なカウントダウン(討伐直後に 22 時間など)を出さないように。
  - **リモート配信化**:MOD のソースを独立管理し、GUI 更新を待たずに修正を配信。タブに「新バージョンあり」が出てワンクリック更新できます。
- **インストールが止まったときの明確な案内**:ダウンロード/インストールが 10 秒を超えると黄色の警告が表示され、多くはゾンビプロセスによるファイル占有だと案内します。PC を再起動(推奨)するか、タスクマネージャーで残った PalServer を終了してから再試行してください。

### 新機能・改善
- **サーバー側フォルダーブラウザ**:インスタンス作成時にサーバーのインストール先を参照して選べます(Tailscale/VPN の帯域も許可され、リモート管理に便利)。
- **捕獲補助の交配**:所持パルで目標に届かない場合、計算機がどのパルを捕獲すべきか提案。ギルド拠点の作業パルも対象にし、パルボックス/拠点の位置を表示。
- **遠距離テレポートの安定化**:2 段階テレポートで成功率向上。ブロードキャストは REST API 経由になり非 ASCII テキストに対応。
- **ARM64 Docker**:FEX エミュレーションで ARM64 ホスト上でもサーバーを動かせる Docker イメージを追加。
- カスタムパルの凝縮数を星ランクでクイック入力。新アイテム「輝く古代文明の遺物」。
- 帯域制限のある地域はミラー URL 経由で MOD をインストール可能(GitHub の CDN を回避)。

</details>
