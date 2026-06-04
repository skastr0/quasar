# Quasar

Quasar is a local-first repository for AI agent sessions. It ingests local
agent histories, normalizes them into an analysis-oriented event graph, and
serves text, semantic, and fusion search through Convex.

V1 focuses on Codex, Claude Code, OpenCode, and Grok history importers. Other
agents are exposed through honest discovery diagnostics until stable local
formats are available.

## Workspace

- `apps/control`: Next dashboard, Convex schema/functions, HTTP API, local/Tailscale scripts.
- `packages/core`: shared schemas, adapter contracts, project/path normalization, importers.
- `packages/cli`: Effect-powered `quasar` CLI with JSON input envelopes.

## Local Setup

```bash
bun install
bun run typecheck
bun run test
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

The dashboard defaults to port `5177`. Tailscale Serve is configured with:

```bash
cd apps/control
bun run local:configure-tailscale
```

Paths are `/` for the dashboard, `/quasar-convex` for the Convex backend, and
`/quasar-api` for the Convex site API.

## CLI Smoke

```bash
bun packages/cli/src/cli.ts doctor
bun packages/cli/src/cli.ts sources discover '{"providers":["codex"],"limit":1}'
bun packages/cli/src/cli.ts ingest plan '{"providers":["codex"],"limit":1}'
```

For server-backed commands, set `QUASAR_CONTROL_URL` and
`QUASAR_CONTROL_TOKEN`, or write `{ "url": "...", "token": "..." }` to
`~/.config/quasar/config.json`.
