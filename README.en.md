# palserver GUI

[繁體中文](README.md) | [简体中文](README.zh-CN.md) | **English** | [日本語](README.ja.md)

<p align="center"><a href="https://palserver-GUI.iosoftware.ai"><b>Official site: palserver-GUI.iosoftware.ai</b></a> — downloads, guides & FAQ</p>

**A graphical management tool for Palworld dedicated servers.**
Run one agent on your host machine, then manage the server from a browser — start the server, tweak settings, watch players, back up saves, install mods, all without touching a command line.

Manage it from your phone, tablet or another computer; friends can join as co-admins with a single link.

```
Browser (React Web UI)
        │  HTTP / WebSocket (Bearer token)
        ▼
   agent (Node/TypeScript, Fastify)
        ├── native backend (default): launches PalServer directly on the host, no Docker needed
        └── docker backend (beta): runs PalServer inside a container
```

---

## Screenshots

> The UI ships in 繁體中文 / 简体中文 / English / 日本語, with six switchable themes (Pal (default) / Silver / Aurora Jade / Midnight Lilac / Sakura Pink / Orange Cat), each with a light and dark variant; players and data in the screenshots are demo content.

![Player management](docs/screenshots/players.png)

| Dashboard | World settings |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | ![World settings](docs/screenshots/settings.png) |
| **Engine tuning** | **Saves & backups** |
| ![Engine tuning](docs/screenshots/engine.png) | ![Saves & backups](docs/screenshots/saves.png) |
| **Mod management** | **Instance overview** |
| ![Mod management](docs/screenshots/mods.png) | ![Instance overview](docs/screenshots/overview.png) |

---

## How to read this document

| You are… | Start here |
| --- | --- |
| **A player / server host** — just want a server up | [For players: a server in five minutes](#for-players-a-server-in-five-minutes) |
| **A server admin** — long-term operation, security & automation | [For admins: operations guide](#for-admins-operations-guide) |
| **A developer** — want to hack on it, send PRs | [For developers: development guide](#for-developers-development-guide) |

If you hit a problem, check the **[FAQ](https://faq.toc.icu/)** first, or ask on [Discord](https://discord.gg/sgMMdUZd3V).

---

## Feature overview

**Hosting & management**
- Create multiple server instances, each with its own world, ports and settings; one-click start / stop / restart / delete (deleting keeps the saves)
- Auto-download and install the Palworld server files (via DepotDownloader), with a **real-time install progress bar**; or **adopt your existing installation directory in place**
- Game version check: compares the installed build against the latest on Steam, with one-click server updates
- Live log streaming (switchable between agent / game / PalDefender sources)
- Launch options panel: the Steam query port **can be customized** (with duplicate-port checks against other instances); `publiclobby` / `logformat` and other launch flags are now part of settings
- **Custom Docker container images**: reuse whatever other Palworld image you're already running on Docker; the docker / k8s backend is **no longer locked to a specific platform** (works on macOS/Windows with Docker Desktop installed; k8s is always selectable)

**World & performance settings**
- Graphical editor for 80+ world settings, grouped by category, with types, ranges and defaults; or edit the raw `PalWorldSettings.ini` directly
- `Engine.ini` performance tuning (tick rate, network rates, timeouts, GC interval, performance flags `useperfthreads` / `NoAsyncLoadingThread` / `UseMultithreadForDS`, worker thread count…) with one-click presets; player bandwidth cap adjustable up to 1 Gbps, with a live Mbps conversion
- Corrupted config detection with "regenerate a clean config" (the broken file is backed up first, never just deleted)

**Player management**
- Online player list: level, ping, coordinates, building count — click a player to see **their Pals and inventory** (requires PalDefender)
- Kick, ban, whitelist — **works on offline players too** (e.g. unbanning someone)
- Past-player roster: the agent samples every 15 seconds, keeping playtime, session counts, first/last seen; join/leave timeline
- Server-wide broadcast, save-now

**Map**
- **Built-in full world map** (Palpagos Islands + Sakurajima + Feybreak, high resolution) — no need to bring your own map image
- **Live markers for online players** + **last-known positions for offline players**; guild bases, a **wild boss (Alpha Pal) layer**, and landmarks (fast travel points / towers / dungeons, names localized to your UI language)
- **Full-screen map** (`/map`), one click away from the live map to open in a new tab
- **Pick coordinates by clicking the map**: for commands that need coordinates (teleport, spawn…), just drop a pin instead of typing numbers

**Console**
- Full RCON console with command search, categories and parameter forms; dangerous commands require confirmation
- Player-ID parameters get a player picker (offline players included); item / Pal / egg IDs get an icon search
- With PalDefender installed, its commands are added automatically
- Pal and item data updated to **Palworld 1.0 (Feybreak)**; active skills / traits localized (Chinese / Japanese)

**Save migration (built in, no CLI needed)**
- **Import save**: next to "Create server", bring an existing world along when creating a new instance — supports three sources: **another dedicated server**, **local co-op saves** (4-player invite code), or **the v1.0 GUI**. Paste the folder path → scan → pick a world; the import auto-backs up first and sets the imported world active
- **Fix host character** (built-in `palworld-host-save-fix`): after moving a co-op save to a dedicated server, the host is normally asked to rebuild their character — the Backups tab detects a co-op host save and offers a one-click transfer, no Python required; supports the newer **PlM (Oodle) save format**, and auto-backs up before fixing
- Character files newly added after an import are auto-tagged **"Added after import"** and pre-selected, so you don't have to guess which one is the host's new character
- Full migration walkthrough: [docs/MIGRATION.md](docs/MIGRATION.md)

**Saves & backups**
- Scheduled automatic backups: interval, retention count, skip when nobody is online
- Manual backup / restore / download; restoring automatically backs up the current world first
- Multi-world management: list all worlds, switch the active world, delete individual player saves; the player character list refreshes live

**Mods**
- One-click install / update / remove for **PalDefender** (anti-cheat, formerly Palguard) and **UE4SS** (Lua/Blueprint mod loader), each with stable and beta channels
- PalDefender settings panel, Lua mod toggles, pak mod management; **PalDefender's REST API port can be changed**
- **MOTD login announcement** now has a settings UI
- File manager: browse, upload, edit and delete files under the server directory

**Stability**
- Auto-restart: scheduled (fixed interval or daily times), memory threshold, crash recovery (with an hourly cap to avoid infinite restart loops)
- Broadcasts a countdown and saves the world before planned restarts; manual stops don't count as crashes

**Sponsor early-access features** (unlocked for active sponsors; opens to everyone once the early-access period ends)
- **Pal stat editor** (via PalSchema): tweak a species' base HP / attack / defense / capture rate etc., **with a separate override for the boss variant**; one-click PalSchema install, a change log, and one-click revert-all
- **Teleport players**: teleport a player to another player, or to **coordinates picked on the map**
- **Bulk-give items**: an item icon picker + quantity, grant several at once
- Custom Pals / eggs, guild base details, landmark names

**Other**
- Four languages: 繁體中文 / 简体中文 / English / 日本語; **six themes** (Pal (default) / Silver / Aurora Jade / Midnight Lilac / Sakura Pink / Orange Cat) **×** light / dark — some themes are sponsor-exclusive
- **Drag-to-reorder** server cards on the home page; tabs can be **customized (show / hide)**; the overview card can be dismissed
- Connectivity diagnostics: detects your public IP, whether you're behind NAT/CGNAT, plus VPN (Tailscale / Radmin) hosting guides
- Optional GUI self-update: checks GitHub Releases, verifies SHA256, swaps binaries and restarts itself

---

## System requirements

| Item | Notes |
| --- | --- |
| **OS** | **Windows 10+ or Linux (x86_64)**. macOS can run the agent but **cannot run the Palworld server** (SteamCMD/PalServer unsupported) — useful only for development or managing remote hosts. |
| **Hardware** | Per Palworld's official requirements; the server files are tens of GB, so the first install takes a while |
| **Node.js** | **Not required** (the portable executable bundles it). Only needed (Node 20+ and pnpm) when running from source |
| **Docker** | Not required. Only for the optional docker backend (beta) |

---

## For players: a server in five minutes

> Full illustrated guide (inviting friends, VPN setup): the **[official site](https://palserver-GUI.iosoftware.ai)** and the **[FAQ](https://faq.toc.icu/)**

1. Download the archive for your OS from [Releases](https://github.com/io-software-ai/palserver-gui/releases)
   (`palserver-agent-windows.zip` / `-linux.zip`) and extract it.
2. Run `palserver-agent` inside (`palserver-agent.exe` on Windows). No Node or Docker install needed.
3. The window prints instructions — open **`http://localhost:8250`**. Local management **needs no password**.
4. Click "Create server". The first run downloads the Palworld server files (**tens of GB — be patient**); the UI shows a live progress bar.
5. Once installed, hit "Start" and you're live.

**Already have an existing world?** Click "Import save" next to "Create server" to bring a world from another server, from local co-op (4-player invite code), or from the v1 GUI into a new instance — see the [save migration guide](docs/MIGRATION.md) for details.

**Inviting friends to co-manage:** the startup window shows a `?setup=XXXX-XXXX` link — send it to them to open in their browser
(they must be on the same LAN or VPN). Or have them open your agent URL and enter the **pairing code**.

**Letting friends join the game:** the easiest way is a VPN (Tailscale or Radmin); the GUI's connection card detects your network
situation and shows matching guides. With a public IP you can also do traditional port forwarding (UDP 8211).

> **About the map:** the GUI ships with a built-in full world map (Palpagos Islands / Sakurajima / Feybreak) — no need to
> bring your own image. Open the "Map" tab or the full-screen `/map` view to see live player positions, last-known
> positions for offline players, guild bases, and wild bosses.

---

## For admins: operations guide

### Security model

The agent has exactly one door: **loopback is unauthenticated; everything else needs a token.**

- **Local management** (`127.0.0.1`) needs no credentials — zero friction for single-machine use.
- **Other devices** either present an API token (`Authorization: Bearer <token>`) or exchange a **pairing code** for one.
  Pairing codes are readable `XXXX-XXXX` strings (confusable characters removed) and can be regenerated at any time,
  which immediately invalidates old codes and links.
- The token lives in the data folder (mode `0600`), generated on first start and printed in the window.
- On shared machines set `PALSERVER_REQUIRE_TOKEN=1` so even loopback requires the token.
- **SteamIDs are masked everywhere**: rosters, logs, player pickers, command output, etc. always show a redacted middle
  (click to reveal / copy); pairing codes and one-click login links are **blurred by default** to prevent leaks in screenshots.

> The agent manipulates files and processes on the host — **do not expose `:8250` directly to the public internet**.
> For remote management use a VPN (Tailscale/WireGuard) or put it behind a TLS reverse proxy.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PALSERVER_DATA_DIR` | `~/.palserver-agent` | Where all state lives |
| `PALSERVER_AGENT_PORT` | `8250` | Listen port |
| `PALSERVER_AGENT_HOST` | `0.0.0.0` | Bind address |
| `PALSERVER_REQUIRE_TOKEN` | unset | `=1` requires the token even on loopback |
| `PALSERVER_TLS` | unset | `=1` serves HTTPS (self-signed cert auto-generated under `<data-dir>/tls`; bring your own if you like) |
| `PALSERVER_WEB_ORIGINS` | empty | Comma-separated web origins allowed cross-origin, for standalone public web deployments |
| `PALSERVER_AUTO_UPDATE` | unset | `=0` disables GUI self-update entirely (not even checks) |
| `PALSERVER_TELEMETRY` | unset | `=0` force-disables anonymous usage stats |
| `PALSERVER_STATS_URL` | official endpoint | Point at your own stats backend |
| `PALSERVER_GITHUB_REPO` | `io-software-ai/palserver-gui` | Which repo's Releases self-update watches |
| `PALSERVER_IMAGE_VANILLA` | `palserver/vanilla:latest` | Image used by the docker backend |

### Where data lives

```
~/.palserver-agent/
├── token                 API token (0600)
├── pair-code             pairing code (0600)
├── instances.json        all instance configs (the single source of truth)
├── tools/                cached DepotDownloader
├── tls/                  self-signed certs (with PALSERVER_TLS=1)
└── instances/<id>/
    ├── server/           server files installed by the agent (absent for adopted installs)
    ├── server.pid        game process pid
    ├── server.log        server output captured by the agent
    └── backups/          tar.gz backups
```

Server processes are spawned **detached**: restarting (or self-updating) the agent does **not** take game servers down;
the pid file lets the agent re-attach.

### Deployment options

**Portable executable (recommended)** — the same path players use; right for almost everyone.

**Running the agent itself in Docker** (Linux hosts):

```sh
docker compose up -d          # see docker-compose.yml
```

Requires mounting `docker.sock`, and host paths must match inside the container (instance directories get bind-mounted
into game containers).

**Standalone web + remote agent** — `palserver-web.zip` in Releases is a deployable frontend; add the site origin to the
agent's `PALSERVER_WEB_ORIGINS` and players can reach their home agent from a public site.

**From source** — see the [development guide](#for-developers-development-guide); `pnpm release:exe` builds your own
portable executable.

### Self-update

Under "Settings → GUI updates". By default it **only checks, never installs** (every 6 hours); when a new version is
found an update card appears and nothing happens until you click:
download the platform `.tar.gz` → **verify against `SHA256SUMS.txt`** → swap the executable and frontend → restart itself.
Auto-install can be enabled.

Safety: refuses to update without the checksum file; refuses when not running as the portable executable (e.g. dev mode);
refuses while a server install is in progress (the downloader is a child process — restarting would kill it); a failed
swap restores the old executable.

### Privacy & anonymous stats

The GUI reports **anonymous** usage counts (installs, servers created/started, unique players) to understand adoption.
No personal data, IPs, server names or save contents; player identifiers are sent as one-way hashes only.
Opt out in Settings, or force-disable with `PALSERVER_TELEMETRY=0`. Full details: **[PRIVACY.md](PRIVACY.md)**.

---

## For developers: development guide

### Architecture

The frontend **never talks directly** to the game's REST API, RCON or PalDefender's API — those credentials stay inside
the agent; the browser only talks to the agent.

| Package | Contents |
| --- | --- |
| `packages/agent` | Fastify daemon: REST + WebSocket API, process management, RCON, backups, mod installs, self-update |
| `packages/web` | React 18 + Vite + Tailwind 4 web UI |
| `packages/shared` | Shared zod schemas & API types (world settings, instance contracts) |
| `packages/stats` | Cloudflare Worker + D1, anonymous stats collector |
| `images/vanilla` | Linux PalServer image for the docker backend (bundles DepotDownloader) |
| `images/dev-stub` | Fake PalServer for development on Apple Silicon |
| `deperated/` | The v1 Electron app, kept only as UX/i18n reference; not part of the workspace |

### Getting started

Requires Node 20+ and pnpm 11.

```sh
pnpm install
pnpm build

pnpm dev:agent    # terminal 1 — agent (prints the API token on first run)
pnpm dev:web      # terminal 2 — web UI on http://localhost:5173
```

The agent listens on `:8250` by default. When `packages/web/dist` exists, the agent serves the frontend itself
(the bundled build).

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | Typecheck the whole workspace (CI runs this) |
| `pnpm build` | Build everything |
| `pnpm bundle:agent` | esbuild-bundle the agent into a single CJS file |
| `pnpm release:exe` | Produce the portable executable for the current platform into `release/` |

### World settings are schema-driven

`packages/shared/src/options.ts` is the **single source of truth**: every option's type, default, range and category
lives there (checked against the [official docs](https://docs.palworldgame.com/)). The zod schema, the agent's ini
serialization and the frontend settings editor are all derived from it — **add an option there and the whole pipeline
just works**. Chinese labels live in `packages/web/src/labels.ts`.

`Engine.ini` and PalDefender's `Config.json` work the same way, and **writes are merges**: sections, keys and comments
the GUI doesn't manage are preserved verbatim.

### i18n

Strings in code are written in **Chinese source text**; `t("中文")` looks the source string up in a dictionary.
`packages/web/public/i18n/{en,ja,zh-CN}.json` map "Chinese → translation"; a missing key falls back to the Chinese original,
so **untranslated strings never break the layout**. Dictionaries refresh from GitHub raw in the background, so
translation fixes don't need a release.

### Developing on Apple Silicon

The real server won't run under Rosetta (SteamCMD is 32-bit; PalServer segfaults on world save). For UI/agent
development use the fake server:

```sh
docker build -t palserver/dev-stub:latest images/dev-stub
PALSERVER_IMAGE_VANILLA=palserver/dev-stub:latest pnpm dev:agent
```

Verifying against a real server needs an x86_64 Windows or Linux machine.

### Releasing

Push a `v*` tag and the [release workflow](.github/workflows/release.yml) builds on all three OSes:

- `palserver-agent-<os>.zip` — for manual download
- `palserver-agent-<os>.tar.gz` — consumed by self-update
- `palserver-web.zip` — standalone deployable frontend
- `SHA256SUMS.txt` — always verified by self-update

---

## Status

**v2 is currently at v2.1.0**, downloadable right now from [Releases](https://github.com/io-software-ai/palserver-gui/releases) —
everything listed above is live.

Not done yet: multi-host aggregation; the docker backend is still beta (`images/modded` not provided yet); advanced
PalDefender features like Pal import rules.

## License & links

**[PolyForm Noncommercial 1.0.0](LICENSE.md)** — source-available: free to use, modify and distribute for personal and
noncommercial purposes; **any commercial / for-profit use is not permitted** (selling this software, bundling it into a
paid service, etc.). For commercial licensing contact <contact@iosoftware.ai>.

- **Official site:** <https://palserver-GUI.iosoftware.ai>
- **FAQ:** <https://faq.toc.icu/>
- **Discord:** <https://discord.gg/sgMMdUZd3V>
- **Save migration:** [docs/MIGRATION.md](docs/MIGRATION.md)
- **Privacy policy:** [PRIVACY.md](PRIVACY.md)
- **v1 (no longer maintained):** <https://github.com/Dalufishe/palserver-GUI>

Made with love by [Dalufish](https://github.com/Dalufishe) and the core team.
