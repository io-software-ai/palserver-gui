// 把 agent(含 @palserver/shared 與所有 npm 相依)打包成單一檔案,作為免安裝
// 執行檔(Node SEA)的基礎。cpu-features 是 ssh2 的可選原生加速模組(.node),
// 無法打包也非必要,標為 external;ssh2 沒有它會自動退回純 JS。dockerode 走本地
// socket,實務上不會用到 ssh2 的連線功能,但 docker-modem 會在載入時 require 它,
// 所以 ssh2 本身要打包進來(純 JS 部分)以免啟動即崩潰。
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 打包進執行檔的版本號 —— 這是自我更新是否「已是最新」的判斷依據,一定要等於這個
 * build 對應的 release tag,否則更新完仍會被判為有新版。
 *  - CI 由 tag 觸發 release:GITHUB_REF_NAME 就是 tag(例如 v2.0.0-alpha.3)。
 *  - 本機/手動 build:退回最近的 git tag,再退回 agent package.json 的版本。
 */
function resolveAgentVersion() {
  const ref = process.env.GITHUB_REF_NAME;
  if (ref && /^v\d/.test(ref)) return ref.replace(/^v/, "");
  try {
    const desc = execSync("git describe --tags --abbrev=0", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (/^v?\d/.test(desc)) return desc.replace(/^v/, "");
  } catch {
    /* 沒有 tag 或不是 git repo，往下退 */
  }
  const pkg = createRequire(import.meta.url)(path.join(root, "packages/agent/package.json"));
  return pkg.version;
}

const version = resolveAgentVersion();

await build({
  entryPoints: [path.join(root, "packages/agent/dist/index.js")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(root, "packages/agent/bundle/agent.cjs"),
  // cpu-features:ssh2 的可選原生加速(見上)。zlib-sync / bufferutil / utf-8-validate:discord.js
  // (@discordjs/ws + ws)的可選原生加速模組(.node),都是 try/catch require,打包不進 SEA;標為
  // external 讓它們留成 runtime require,載入失敗時 discord.js/ws 自動退回純 JS(功能不受影響)。
  external: ["cpu-features", "zlib-sync", "bufferutil", "utf-8-validate"],
  // 把版本烙進 bundle:env.ts 讀 process.env.PALSERVER_AGENT_VERSION,這裡換成字面值。
  define: { "process.env.PALSERVER_AGENT_VERSION": JSON.stringify(version) },
  logLevel: "info",
});

console.log(`bundled → packages/agent/bundle/agent.cjs (version ${version})`);
