# palserver GUI v2

Palworld dedicated server management — an agent daemon runs on the server host, a React Web UI connects to it remotely.

```
Web UI (React) ──HTTP/WS + Bearer token──▶ Agent (Node/TS, Fastify)
                                            ├─▶ native driver (default): spawns PalServer
                                            │     directly on the host, no Docker needed
                                            └─▶ docker driver (optional): PalServer containers
```

**Backends** (chosen per instance at creation):

- **native** (default) — the agent spawns `PalServer.exe` / `PalServer.sh` as a
  detached host process. It can adopt an existing dedicated-server install
  (point `serverDir` at it) or auto-install one via DepotDownloader. Survives
  agent restarts (pid-file reattach); graceful stop via the server's REST API
  when enabled, force-kill fallback. Works on any Windows/Linux box — no Docker.
- **docker** — the original container flavor, kept for Linux hosts and
  isolation-minded setups.

## Packages

| Path | What it is |
| --- | --- |
| `packages/agent` | Daemon: REST + WebSocket API, Docker orchestration (dockerode), settings → `PalWorldSettings.ini` rendering, token auth |
| `packages/web` | React + Vite Web UI: connect to any agent, instance dashboard, create/start/stop/restart, live logs |
| `packages/shared` | Shared zod schemas and API types (world settings, instance contract) |
| `images/vanilla` | Native Linux PalServer image (SteamCMD, installs/updates at boot) |
| `images/modded` | (planned) Wine/Proton flavor with UE4SS + Palguard support |

## Development

```sh
pnpm install
pnpm build

# terminal 1 — agent (prints the API token on first start)
pnpm dev:agent

# terminal 2 — web UI on http://localhost:5173
pnpm dev:web
```

The agent listens on `:8250` by default and stores state in `~/.palserver-agent` (`PALSERVER_AGENT_PORT` / `PALSERVER_DATA_DIR` to override). When `packages/web/dist` exists, the agent serves the UI itself.

## Building the server image

```sh
docker build -t palserver/vanilla:latest images/vanilla
```

Instances are containers labeled `app.palserver.instance=<id>`; world saves live under `<data-dir>/instances/<id>/saved` on the host and survive container removal. Settings edits apply on the next restart.

## World settings

`packages/shared/src/options.ts` is the single source of truth: every option's
type, default, range and category (per the official docs at
docs.palworldgame.com). The zod schema, the agent's ini serializer and the web
settings editor are all derived from it — adding an option there surfaces it
end to end. Labels live in `packages/web/src/labels.ts` (zh_tw, carried over
from v1 locales).

## Developing on Apple Silicon

The real server cannot run under Rosetta (SteamCMD is 32-bit; PalServer
segfaults at world-save creation). Use the fake server for UI/agent work:

```sh
docker build -t palserver/dev-stub:latest images/dev-stub
PALSERVER_IMAGE_VANILLA=palserver/dev-stub:latest pnpm dev:agent
```

Real-server verification needs an x86_64 Linux host.

## Status / roadmap

- [x] Agent: instance CRUD, start/stop/restart, log streaming, stats, token auth
- [x] Web UI: connect → dashboard → instance detail (overview / world settings / logs)
- [x] World-settings editor: schema-driven, 80+ options, category tabs, apply-on-restart
- [x] Native backend (default): spawn/adopt host PalServer, DepotDownloader auto-install,
      pid reattach across agent restarts, REST-API graceful shutdown
- [x] Docker backend (optional): vanilla image via DepotDownloader; dev-stub image for macOS
- [ ] UE4SS + Palguard management on the native backend (v1 parity — core theme)
- [ ] Player management via Palworld REST API / RCON passthrough
- [ ] Save migration: import an existing world into an instance (v1 parity)
- [ ] Failure detection surfaced in UI (process exits / container crash loops)
- [ ] Backups & schedules, multi-host aggregation in the UI, TLS guidance, i18n (reuse v1 locales)
