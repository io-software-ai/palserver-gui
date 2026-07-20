import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "packages", "web", "public");
const gameDataDir = path.join(publicDir, "game-data");
const outputDir = path.join(publicDir, ".bridge-card-renderer");
const rendererAssetsDir = path.join(root, "assets", "message-card");
const agentRequire = createRequire(path.join(root, "packages", "agent", "package.json"));

function packageDir(requireFrom, name) {
  let current = path.dirname(requireFrom.resolve(name));
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === name) return current;
    current = path.dirname(current);
  }
  throw new Error(`Cannot locate package directory for ${name}`);
}

async function mapLimit(values, limit, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await worker(values[index]);
    }
  }));
}

async function buildIconCache(folder, size) {
  const source = path.join(gameDataDir, folder);
  const destination = path.join(outputDir, "icons", folder);
  fs.mkdirSync(destination, { recursive: true });
  const files = fs.readdirSync(source).filter((name) => /\.(?:png|webp)$/i.test(name));
  await mapLimit(files, 12, async (name) => {
    await sharp(path.join(source, name))
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ palette: true, colours: 128, compressionLevel: 9 })
      .toFile(path.join(destination, `${path.parse(name).name}.png`));
  });
  return files.length;
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const resvgDir = packageDir(agentRequire, "@resvg/resvg-wasm");
fs.copyFileSync(path.join(resvgDir, "index_bg.wasm"), path.join(outputDir, "resvg.wasm"));

const fontsOutput = path.join(outputDir, "fonts");
fs.mkdirSync(fontsOutput, { recursive: true });
fs.copyFileSync(
  path.join(rendererAssetsDir, "PalserverBridgeRounded.woff2"),
  path.join(fontsOutput, "PalserverBridgeRounded.woff2"),
);

const [pals, items] = await Promise.all([
  buildIconCache("pals", 104),
  buildIconCache("items", 92),
]);

const licensesOutput = path.join(outputDir, "licenses");
fs.mkdirSync(licensesOutput, { recursive: true });
fs.copyFileSync(path.join(rendererAssetsDir, "OFL-1.1.txt"), path.join(licensesOutput, "Noto-Sans-SIL-OFL-1.1.txt"));

const bytes = fs.statSync(path.join(outputDir, "resvg.wasm")).size;
console.log(`message-card assets -> ${path.relative(root, outputDir)} (${pals} pals, ${items} items, WASM ${Math.round(bytes / 1024)} KiB)`);
