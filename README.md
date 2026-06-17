# Quasar

Status: pre-release, under an active v2 rebuild.

Quasar is a local-first repository for AI agent sessions. It ingests local
agent histories, normalizes them into session and tool-call rows, and serves
bounded session inspection through a self-hosted Convex backend consumed by a
CLI and agent MCP tools. Search is intentionally absent while the removed
Convex Searchlight/RAG path is replaced by LanceDB.

The single current architecture direction is
[docs/architecture/quasar-data-reality-plan-2026-06-11.md](docs/architecture/quasar-data-reality-plan-2026-06-11.md)
together with
[docs/architecture/convex-grain-quasar-v2.md](docs/architecture/convex-grain-quasar-v2.md).
Other architecture documents are historical post-mortems.

Honest current state: this repository contains provider session parsing,
normalization, redaction, a CLI, and a self-hosted Convex OLTP backend for
projects, sessions, messages, and tool calls. Convex search/RAG state was
removed; LanceDB owns the next search implementation. Adapters exist for the
providers with data on a real host: Codex, Claude Code, OpenCode, Grok,
Hermes, and Antigravity. Extraction is read-only; brittle local formats fail
soft with diagnostics rather than writing to native history.

## Workspace

- `packages/core`: private shared schemas, adapter contracts, project/path normalization, importers.
- `packages/cli`: the `quasar` CLI with JSON input envelopes.
- `convex`: the self-hosted Convex OLTP app.

The dashboard is not present. Only the CLI is prepared for npm publication.

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
folders. Server hosting is self-hosted Convex over Tailscale; search is rebuilt
through LanceDB in the next search glyphs.

## CLI Smoke

```bash
bun packages/cli/src/cli.ts doctor
bun packages/cli/src/cli.ts capabilities
bun packages/cli/src/cli.ts sources discover '{"providers":["codex"],"limit":1}'
```

## Security and License

See `SECURITY.md` for vulnerability reporting and supported status.

Quasar is licensed under the MIT License.
