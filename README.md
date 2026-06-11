# Quasar

Status: pre-release, under an active v2 rebuild.

Quasar is a local-first repository for AI agent sessions. It ingests local
agent histories, normalizes them into searchable session intelligence, and
serves text, semantic, and fusion search through a self-hosted Convex backend
consumed by a CLI and agent MCP tools.

The single current architecture direction is
[docs/architecture/quasar-v2-greenfield-plan-2026-06-10.md](docs/architecture/quasar-v2-greenfield-plan-2026-06-10.md)
together with
[docs/architecture/convex-grain-quasar-v2.md](docs/architecture/convex-grain-quasar-v2.md).
Other architecture documents are historical post-mortems.

Honest current state: provider discovery, parsing, and the Convex search/read
substrate exist; **the ingest write plane was removed** (the previous
record-stream architecture was abandoned) and `quasar ingest` reports
`not_ready` until the v2 sync contract lands with its measured byte/memory
gates. Adapters exist for the providers with data on a real host: Codex,
Claude Code, OpenCode, Grok, and Hermes. Adapters for providers without data
(Amp, Pi, Kimi, Factory/Droid, Antigravity, Cursor) were removed and are
re-admitted only when data and a consuming endpoint exist; their parsing
knowledge remains in git history. Extraction is read-only; brittle local
formats fail soft with diagnostics rather than writing to native history.

## Workspace

- `apps/control`: Next dashboard, Convex schema/functions, HTTP API, local/Tailscale scripts.
- `packages/core`: private shared schemas, adapter contracts, project/path normalization, importers.
- `packages/cli`: npm-published `quasar` CLI with JSON input envelopes.

Only the CLI is prepared for npm publication. The Convex app, dashboard, and
shared core workspace package are not npm publish surfaces.

## Local Setup

```bash
bun install
bun run typecheck
bun run test
```

## CLI

Once published, install the CLI package with:

```bash
npm install -g @skastr0/quasar-cli
quasar --help
```

Ephemeral runner examples:

```bash
npx --package @skastr0/quasar-cli quasar --help
bunx -p @skastr0/quasar-cli quasar --help
pnpm --package @skastr0/quasar-cli dlx quasar --help
```

Quasar stores durable local service state under `~/.quasar-control` by default
and stores the CLI machine identity/config under `~/.config/quasar`. Extraction
is read-only: adapters do not write to native agent history folders.

Convex local deployment metadata is initialized with:

```bash
cd apps/control
bun run local:init
```

With Convex 1.40, creating local deployment metadata requires a logged-in,
configured Convex project. If local init reports that Convex refused anonymous
creation, run the commands it prints, then rerun `bun run local:init`.

## Running

```bash
cd apps/control
bun run local:backend
bun run local:push
bun run local:build
bun run local:serve
```

Routine local deploys mirror Tower/Booth:

```bash
cd apps/control
bun run deploy
```

`deploy` verifies tests/types, backs up local Convex state, ensures the local
backend is running, pushes Convex functions, builds the dashboard for Tailscale
URLs, installs launchd agents, configures Tailscale Serve, and verifies local
fallback endpoints. It initializes local Convex metadata only when that metadata
is missing.

The dashboard defaults to port `5177`. Tailscale-backed deploy commands require
`QUASAR_TAILSCALE_HOST`, for example:

```bash
export QUASAR_TAILSCALE_HOST="quasar.<tailnet>.ts.net"
```

Tailscale Serve is configured with:

```bash
cd apps/control
bun run local:configure-tailscale
```

Paths are `/` for the dashboard, `/quasar-convex` for the Convex backend, and
`/quasar-api` for the Convex site API. Tailscale may require admin approval
before `svc:quasar` becomes reachable.

`local:configure-tailscale` also exposes DNS-free fallback ports on the local
machine's Tailnet IP and writes the CLI config to
`~/.config/quasar/config.json`:

- dashboard: `http://<tailnet-ip>:8177`
- Convex client endpoint: `http://<tailnet-ip>:8178`
- Convex HTTP actions endpoint: `http://<tailnet-ip>:8179`

## CLI Smoke

```bash
bun packages/cli/src/cli.ts doctor
bun packages/cli/src/cli.ts sources discover '{"providers":["codex"],"limit":1}'
bun packages/cli/src/cli.ts ingest plan '{"providers":["codex"],"limit":1}'
```

For server-backed commands, set `QUASAR_CONTROL_URL` and
`QUASAR_CONTROL_TOKEN`, or write `{ "url": "...", "token": "..." }` to
`~/.config/quasar/config.json`.

## Security and License

See `SECURITY.md` for vulnerability reporting and supported status.

Quasar is licensed under the MIT License.
