import path from "node:path";
import os from "node:os";
import pkg from "../package.json" with { type: "json" };
import { loadSettings } from "./settings.js";

/** GUI 面板寫入的設定(env > settings.json > 預設)。有設環境變數的欄位以 env 為準。 */
const S = loadSettings();
const envSet = (k: string) => process.env[k] !== undefined;
/** 哪些欄位「由環境變數鎖定」(面板會顯示為不可改的灰化狀態)。 */
export const ENV_LOCKED = {
  requireToken: envSet("PALSERVER_REQUIRE_TOKEN"),
  tls: envSet("PALSERVER_TLS"),
  agentPort: envSet("PALSERVER_AGENT_PORT"),
  agentHost: envSet("PALSERVER_AGENT_HOST"),
  webOrigins: envSet("PALSERVER_WEB_ORIGINS"),
  autoOpenBrowser: envSet("PALSERVER_NO_OPEN") || envSet("PALSERVER_OPEN"),
};

/**
 * 版本字串。release 打包時由 bundle-agent.mjs 依 git tag 用 esbuild define 注入
 * process.env.PALSERVER_AGENT_VERSION(所以免安裝執行檔的版本永遠等於它被建置的那個
 * tag)。開發時沒注入就退回下面這個字面值。務必:每次發版讓 tag 決定版本,不要再靠手改。
 */
export const AGENT_VERSION = process.env.PALSERVER_AGENT_VERSION ?? pkg.version;

export const DATA_DIR = process.env.PALSERVER_DATA_DIR
  ? path.resolve(process.env.PALSERVER_DATA_DIR)
  : path.join(os.homedir(), ".palserver-agent");

export const PORT = Number(process.env.PALSERVER_AGENT_PORT ?? S.agentPort ?? 8250);
export const HOST = process.env.PALSERVER_AGENT_HOST ?? S.agentHost ?? "0.0.0.0";

/** 預設連本機(loopback)免 token;設 =1(或面板開啟)強制一律要 token。 */
export const REQUIRE_TOKEN = ENV_LOCKED.requireToken
  ? process.env.PALSERVER_REQUIRE_TOKEN === "1"
  : (S.requireToken ?? false);

/**
 * 允許跨源連線的網站來源(逗號分隔)。同源(合一版)與本機各埠一律允許,不必列;
 * 這裡是給「純 web 公開站」用的,例如 https://palserver-gui.example.com。
 */
export const WEB_ORIGINS = (process.env.PALSERVER_WEB_ORIGINS ?? S.webOrigins ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 設 =1(或面板開啟)以 HTTPS 監聽(自簽憑證自動生成於 data-dir/tls,或放自己的憑證進去)。 */
export const TLS_ENABLED = ENV_LOCKED.tls
  ? process.env.PALSERVER_TLS === "1"
  : (S.tls ?? false);

/** 是否以「免安裝執行檔」執行(玩家雙擊的那顆),而非開發模式的 node/tsx。
 *  判斷依據:execPath 的檔名就是我們的執行檔;開發時它會是 node 或 tsx。 */
export const IS_PORTABLE_EXE = (() => {
  const base = path.basename(process.execPath).toLowerCase();
  return base === "palserver-agent" || base === "palserver-agent.exe";
})();

/** 啟動時自動打開瀏覽器到本機管理介面。
 *  預設只在免安裝執行檔(玩家雙擊)時開 —— 開發模式(pnpm dev / tsx watch)不開,
 *  否則每次存檔重啟都會彈一個新分頁。可用環境變數覆寫:
 *    PALSERVER_NO_OPEN=1 一律不開;PALSERVER_OPEN=1 一律開(即使開發模式)。 */
export const OPEN_BROWSER =
  process.env.PALSERVER_NO_OPEN === "1"
    ? false
    : process.env.PALSERVER_OPEN === "1"
      ? true
      : (S.autoOpenBrowser ?? IS_PORTABLE_EXE);

/** Docker images used for each flavor; override to pin versions or use a registry. */
export const IMAGES: Record<"vanilla" | "modded", string> = {
  vanilla: process.env.PALSERVER_IMAGE_VANILLA ?? "palserver/vanilla:latest",
  modded: process.env.PALSERVER_IMAGE_MODDED ?? "palserver/modded:latest",
};

/** Wine variants — Windows binary under Wine (PalDefender compatible). */
export const IMAGES_WINE: Record<"vanilla" | "modded", string> = {
  vanilla: process.env.PALSERVER_IMAGE_WINE ?? "palserver/wine:latest",
  modded: process.env.PALSERVER_IMAGE_WINE_MODDED ?? "palserver/wine-modded:latest",
};

/** ARM64 variants — native Linux server via FEX translation (no Wine). */
export const IMAGES_ARM64: Record<"vanilla" | "modded", string> = {
  vanilla: process.env.PALSERVER_IMAGE_ARM64 ?? "palserver/vanilla-arm64:latest",
  modded: process.env.PALSERVER_IMAGE_ARM64_MODDED ?? "palserver/vanilla-arm64:latest",
};

/** GUI 自己的 GitHub repo — 自我更新從這裡的 Releases 取得新版。 */
export const GITHUB_REPO = process.env.PALSERVER_GITHUB_REPO ?? "io-software-ai/palserver-gui";

/** 設 PALSERVER_AUTO_UPDATE=0 完全停用自我更新(連檢查都不做)。 */
export const AUTO_UPDATE_DISABLED_BY_ENV = process.env.PALSERVER_AUTO_UPDATE === "0";

/** 匿名使用統計收集端(見 PRIVACY.md);部署自己的 worker 後可用環境變數覆寫。
 * 自訂網域為主、workers.dev 為備 —— *.workers.dev 在部分地區(中國大陸線路)被 DNS 污染,連不上。 */
export const STATS_URLS = process.env.PALSERVER_STATS_URL
  ? [process.env.PALSERVER_STATS_URL]
  : ["https://stats.iosoftware.ai", "https://palserver-stats.iosoftware.workers.dev"];
export const STATS_URL = STATS_URLS[0];

/** 設 PALSERVER_TELEMETRY=0 強制停用匿名使用統計(優先於 GUI 內的開關)。 */
export const TELEMETRY_DISABLED_BY_ENV = process.env.PALSERVER_TELEMETRY === "0";

/** 贊助者識別碼(先行版授權)驗證端 —— 與 stats 同一個 worker,可用環境變數覆寫。 */
export const LICENSE_URLS = process.env.PALSERVER_LICENSE_URL
  ? [process.env.PALSERVER_LICENSE_URL]
  : STATS_URLS;

/** 公開地圖 viewer 的網址(shareId 組出完整分享連結,見 public-map.ts)。
 * 自架/測試時可用環境變數覆寫。 */
export const PALSERVER_MAP_VIEWER =
  process.env.PALSERVER_MAP_VIEWER ?? "https://palserver-gui.iosoftware.ai/map/";

export const CONTAINER_PREFIX = "palserver-";
export const INSTANCE_LABEL = "app.palserver.instance";

/** k8s backend: 自訂 kubeconfig 檔案路徑（SSH tunnel 場景）。
 * 未設定時，依序嘗試 in-cluster 憑證 → ~/.kube/config。 */
export const KUBECONFIG_PATH = process.env.PALSERVER_KUBECONFIG ?? "";
