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

Honest current state: this repository contains the salvage from two abandoned
ingest architectures — provider session parsing, normalization, redaction, and
a local read-only CLI — plus the v2 plan. There is no server, no ingest, and
no search yet; the v2 build sequence creates them fresh against measured
gates. Adapters exist for the providers with data on a real host: Codex,
Claude Code, OpenCode, Grok, and Hermes. Adapters for providers without data
(Amp, Pi, Kimi, Factory/Droid, Antigravity, Cursor) were removed and are
re-admitted only when data and a consuming endpoint exist; their parsing
knowledge remains in git history. Extraction is read-only; brittle local
formats fail soft with diagnostics rather than writing to native history.

## Workspace

- `packages/core`: private shared schemas, adapter contracts, project/path normalization, importers.
- `packages/cli`: the `quasar` CLI with JSON input envelopes (local, read-only commands today).

The previous Convex app and dashboard (`apps/control`) were removed with the
abandoned ingest architecture; the v2 server is rebuilt per the architecture
plan. Only the CLI is prepared for npm publication.

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

Extraction is read-only: adapters do not write to native agent history
folders. Server hosting (self-hosted Convex over Tailscale) is specified in the
v2 plan and provisioned by its build sequence; no server exists in this
repository today.

## CLI Smoke

```bash
bun packages/cli/src/cli.ts doctor
bun packages/cli/src/cli.ts capabilities
bun packages/cli/src/cli.ts sources discover '{"providers":["codex"],"limit":1}'
```

## Security and License

See `SECURITY.md` for vulnerability reporting and supported status.

Quasar is licensed under the MIT License.
