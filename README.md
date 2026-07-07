# Quasar

Status: pre-release, under an active v2 rebuild.

Quasar is a local-first repository for AI agent sessions. It ingests local
agent histories, normalizes them into session and tool-call rows, and serves
bounded session inspection through a local Effect server consumed by a CLI and
agent MCP tools. SQLite is the whole data plane: truth store, durable queue,
trigger-maintained FTS (lexical search), and message vectors. Semantic and
fusion search serve live from a resident f16 vector matrix (exact scan via a
simsimd SIMD kernel); query embedding runs on a local fp32 ONNX model baked
into the server image, with a bounded synthetic-API fallback while it loads.

The single current architecture direction is
[docs/architecture/quasar-first-principles-rearchitecture-2026-07-03.md](docs/architecture/quasar-first-principles-rearchitecture-2026-07-03.md).
The measured corpus evidence and normalized entity model live in
[docs/architecture/quasar-data-reality-plan-2026-06-11.md](docs/architecture/quasar-data-reality-plan-2026-06-11.md).

Honest current state: this repository contains provider session parsing,
normalization, redaction, a CLI, and a server serving all three search modes
(lexical, semantic, fusion) from SQLite plus the resident vector matrix.
Adapters exist for the providers with data on a real host: Codex, Claude Code,
OpenCode, Grok, Kimi, Hermes, and Antigravity. Extraction is read-only; brittle
local formats fail soft with diagnostics rather than writing to native history.
Session re-ingest applies row-level diffs, so live sessions cost only their
delta on each daemon tick and ingest never blocks search.

## Workspace

- `packages/cli`: the `quasar` CLI — provider history parsing (adapters), session mapping, ingest client, and JSON query commands.
- `packages/server`: the local Effect server: SQLite truth, durable queue, embedding worker, FTS search, and HTTP control surface.

The dashboard is not present. Only the CLI is prepared for npm publication.

## Local Setup

```bash
bun install
bun run typecheck
bun run test
```

## CLI

Production ingest/search/read operations use the `quasar` CLI against the Mac
mini server service:

```bash
export QUASAR_SERVER_URL=https://<quasar-service-tailnet-hostname>
quasar stats
quasar search --mode lexical --query "project identity" --limit 3
```

The client config file is `~/.config/quasar/config.json`; its canonical server
field is `serverUrl`. Client machines should point that field at the
Tailscale Service hostname for `svc:quasar`, not the Mac mini device IP. Remote
write ingest and daemon installs also require `ingestToken` in that config, or
`QUASAR_INGEST_TOKEN` / `--ingest-token`.

Once published, install the CLI package with:

```bash
npm install -g @skastr0/quasar-cli
quasar --version
quasar --help
```

Ephemeral runner examples:

```bash
npx --package @skastr0/quasar-cli quasar --help
bunx -p @skastr0/quasar-cli quasar --help
pnpm --package @skastr0/quasar-cli dlx quasar --help
```

Extraction is read-only: adapters do not write to native agent history folders.
The production target is a local server on the Mac mini, reachable over
Tailscale, with a persistent SQLite volume.

## Security and License

See `SECURITY.md` for vulnerability reporting and supported status.

Quasar is licensed under the MIT License.
