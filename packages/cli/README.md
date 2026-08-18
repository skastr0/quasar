# Quasar CLI

The Quasar CLI discovers, parses, normalizes, ingests, queries, and inspects local AI-agent session histories.

Quasar interfaces with a local Effect server backed by SQLite as the single source of truth, durable worker queues, trigger-maintained SQLite FTS5 lexical search, and a resident f16 vector matrix scanned via SIMD (simsimd FFI) for semantic and hybrid fusion search. The npm package ships a Node launcher plus prebuilt Bun standalone binaries for macOS and Linux (arm64 and x64).

---

## Table of Contents

- [Installation](#installation)
- [Configuration & Server Routing](#configuration--server-routing)
- [Supported Providers (13 Providers)](#supported-providers-13-providers)
- [CLI Commands (All 24 Commands)](#cli-commands-all-24-commands)
  - [Ingestion & Sync](#ingestion--sync)
  - [Background Daemon (macOS launchd)](#background-daemon-macos-launchd)
  - [Discovery & Status](#discovery--status)
  - [Search & Query Interface](#search--query-interface)
  - [Session & Message Inspection](#session--message-inspection)
  - [Tool Call Forensics](#tool-call-forensics)
  - [Trajectory Export](#trajectory-export)
  - [Research Export](#research-export)
  - [Session Enrichments](#session-enrichments)
  - [Vector Maintenance & Queue Operations](#vector-maintenance--queue-operations)
  - [Schema & Introspection](#schema--introspection)
  - [Interactive Terminal UI (TUI)](#interactive-terminal-ui-tui)
- [Interactive Terminal UI (TUI) Keymap & Usage](#interactive-terminal-ui-tui-keymap--usage)
- [Query Spec, Filters & Projections](#query-spec-filters--projections)
- [JSON Output & Dual Envelope Model](#json-output--dual-envelope-model)
- [JSON Piping & Automation Recipes](#json-piping--automation-recipes)
- [Environment Variables Reference](#environment-variables-reference)

---

## Installation

Install globally via npm:

```bash
npm install -g @skastr0/quasar-cli
quasar --version
quasar --help
```

Or run ephemerally with your package manager of choice:

```bash
# npx
npx --package @skastr0/quasar-cli quasar --version

# bunx
bunx -p @skastr0/quasar-cli quasar --version

# pnpm dlx
pnpm --package @skastr0/quasar-cli dlx quasar --version
```

Prebuilt standalone binaries are distributed across native platform packages:
- `@skastr0/quasar-cli-darwin-arm64` (Apple Silicon)
- `@skastr0/quasar-cli-darwin-x64` (Intel macOS)
- `@skastr0/quasar-cli-linux-arm64` (Linux ARM64)
- `@skastr0/quasar-cli-linux-x64` (Linux x86_64)

---

## Configuration & Server Routing

Client commands route to an active Quasar Effect server (local or reached over Tailscale). Configuration is resolved in the following priority:

1. Command-line flags (`--server <url>`, `--ingest-token <token>`)
2. Environment variables (`QUASAR_SERVER_URL`, `QUASAR_INGEST_TOKEN`)
3. Configuration file (`~/.config/quasar/config.json` or path in `QUASAR_CONFIG`)

### Default Configuration File

Create `~/.config/quasar/config.json`:

```json
{
  "schemaVersion": 3,
  "projectKey": "quasar",
  "serverUrl": "https://<quasar-service-tailnet-hostname>",
  "ingestToken": "<same-token-configured-on-the-mac-mini-server>"
}
```

> [!NOTE]
> `ingest` and `daemon run` read native local history files on the host running the CLI and stream normalized sessions to the configured server. Remote ingest requires `ingestToken`, `QUASAR_INGEST_TOKEN`, or `--ingest-token <token>`; read and search commands do not require authentication tokens.

---

## Supported Providers (13 Providers)

Quasar provides deterministic adapters for 13 AI agent and coding assistant session formats. Adapters normalize heterogeneous source structures into canonical `NormalizedSession` records with full transcript lineage, execution context, usage metrics, and tool calls.

| Provider | Adapter ID | Native Storage | Default Root Path | Environment Override |
|---|---|---|---|---|
| **Codex** | `codex-local-jsonl` | JSONL session files | `~/.codex` | `QUASAR_CODEX_ROOT` / `CODEX_HOME` |
| **Claude Code** | `claude-code-local` | JSON session files | `~/.claude` | `QUASAR_CLAUDE_ROOT` / `CLAUDE_HOME` |
| **OpenCode** | `opencode-local-jsonl` | JSONL sessions | `~/.local/share/opencode` | `QUASAR_OPENCODE_ROOT` / `OPENCODE_HOME` |
| **Grok** | `grok-local-jsonl` | JSONL sessions | `~/.grok` | `QUASAR_GROK_ROOT` / `GROK_HOME` |
| **Hermes** | `hermes-local-sqlite` | SQLite database | `~/.hermes` | `QUASAR_HERMES_ROOT` / `HERMES_HOME` |
| **Kimi** | `kimi-local-json` | JSON session state | `~/.kimi` | `QUASAR_KIMI_ROOT` / `KIMI_HOME` |
| **Antigravity** | `antigravity-local-json` | JSON artifacts / state | `~/.gemini/antigravity-cli` | `QUASAR_ANTIGRAVITY_ROOT` / `ANTIGRAVITY_HOME` |
| **OMP** | `omp-local-json` | JSON session tree | `~/.omp` | `QUASAR_OMP_ROOT` / `OMP_HOME` |
| **Pi** | `pi-local-jsonl` | Append-tree JSONL | `~/.pi` | `QUASAR_PI_ROOT` / `PI_HOME` |
| **Prime** | `prime-local-json` | JSON session files | `~/.prime` | `QUASAR_PRIME_ROOT` / `PRIME_HOME` |
| **Cursor** | `cursor-local-sqlite` | SQLite state DB | `~/Library/Application Support/Cursor` | `QUASAR_CURSOR_ROOT` / `CURSOR_HOME` |
| **Devin** | `devin-local-sqlite` | SQLite session DB | `~/.devin` | `QUASAR_DEVIN_ROOT` / `DEVIN_HOME` |
| **Amp** | `amp-local-json` | JSON session files | `~/.amp` | `QUASAR_AMP_ROOT` / `AMP_HOME` |

---

## CLI Commands (All 24 Commands)

Every command produces structured JSON on `stdout`. Subcommand help is accessible via `quasar <command> --help` or `quasar help <command>`.

### Ingestion & Sync

#### 1. `ingest`
Scans local provider directories, normalizes new and updated sessions, and ingests them into the Quasar server. Utilizes a local stat-manifest (`~/.config/quasar/ingest-manifest.json`) for incremental delta uploads.

```bash
quasar ingest [--provider <all|codex|claude|opencode|grok|kimi|hermes|antigravity|omp|pi|prime|cursor|devin|amp>] [--server <url>] [--ingest-token <token>] [--limit <n>] [--force] [--summary]
```

- `--provider <name>`: Target a specific provider or `all` (default: `all`).
- `--limit <n>`: Maximum number of sessions to scan and process.
- `--force`: Bypass the stat-manifest and re-evaluate all discovered session files.
- `--summary`: Output a condensed summary report omitting per-session arrays.

#### 2. `ingest-runs`
Lists recent server ingestion runs, run statuses, processed session counts, and error summaries.

```bash
quasar ingest-runs [--status <running|completed|failed>] [--limit <n>] [--offset <n>] [--server <url>]
```

---

### Background Daemon (macOS launchd)

#### 3. `daemon`
Controls the background remote-ingest daemon via macOS `launchd`. The daemon regularly synchronizes modified local session histories with the Quasar server using non-overlapping file locks.

```bash
# Install and bootstrap the LaunchAgent plist
quasar daemon install --server https://<quasar-host> --ingest-token <token> [--interval-seconds <n>] [--binary <path>]

# Check daemon running state, loaded plist, and lock file status
quasar daemon status

# Remove LaunchAgent and unload from launchd
quasar daemon uninstall

# Execute a single scheduled sync tick (invoked by launchd)
quasar daemon run
```

- `--interval-seconds <n>`: Synchronization interval in seconds (minimum: `10`, default: `15` or `60`).
- `--binary <path>`: Absolute path to the Quasar binary to execute (defaults to current runtime binary).

---

### Discovery & Status

#### 4. `stats`
Fetches server status, active store metrics, total session/message/tool counts, index coverage, and queue depths.

```bash
quasar stats [--server <url>]
```

#### 5. `projects`
Lists distinct projects discovered and normalized across the ingested corpus.

```bash
quasar projects [--limit <n>] [--offset <n>] [--server <url>]
```

#### 6. `workers`
Displays the real-time status of server background workers (durable queue processing, FTS indexers, vector embeddings).

```bash
quasar workers [--server <url>]
```

#### 7. `doctor`
Runs diagnostic checks against the server database, vector matrix index, and provider adapters.

```bash
quasar doctor [--server <url>]
```

---

### Search & Query Interface

#### 8. `search`
Executes lexical (FTS5), semantic (SIMD vector cosine), or hybrid fusion search across indexed conversational messages.

```bash
quasar search --query <text> [--mode <lexical|semantic|fusion>] [--project <key>] [--provider <name[,name]>] [--role <user|assistant|reasoning>] [--agent <name>] [--agent-role <role>] [--model <slug>] [--model-provider <name>] [--fields <a,b>] [--detail] [--cursor <token>] [--limit <n>] [--server <url>]
```

- `-q`, `--query <text>`: Free-text search query.
- `--mode <lexical|semantic|fusion>`: Search retrieval mode (default: `lexical`).
- `--fields <field1,field2>`: Restrict response items to specific projected fields.
- `--detail`: Return full detail projection instead of summary projection.
- `--cursor <token>`: Opaque cursor for deterministic pagination (`page.nextCursor`).
- `--limit <n>`: Number of results to return (1 to 200, default: server configured).

#### 9. `query`
Executes an arbitrary `QuerySpec` JSON payload against the server query endpoint. Accepts inline JSON, `@filepath`, or `-` for stdin.

```bash
# Inline JSON
quasar query '{"protocolVersion":"quasar.query/v1","kind":"search","text":"loss","mode":"fusion","projection":{"detail":"summary","fields":["sessionId","text","score"]},"page":{"limit":5}}'

# From file
quasar query @my-query.json

# Piped from stdin
cat query.json | quasar query -
```

---

### Session & Message Inspection

#### 10. `sessions`
Queries and lists ingested session records with optional filtering by project, provider, agent, or model.

```bash
quasar sessions [--project <key>] [--provider <name[,name]>] [--session <id>] [--agent <name>] [--agent-role <role>] [--model <slug>] [--model-provider <name>] [--fields <a,b>] [--detail] [--cursor <token>] [--limit <n>] [--server <url>]
```

#### 11. `session`
Retrieves comprehensive details for a single session, including messages, tool calls, lifecycle events, execution contexts, usage metrics, and artifacts.

```bash
quasar session --id <sessionId> [--message-limit <n>] [--tool-call-limit <n>] [--event-limit <n>] [--usage-limit <n>] [--edge-limit <n>] [--artifact-limit <n>] [--context-limit <n>] [--server <url>]
```

- `--id <sessionId>`: Full canonical session identifier (e.g. `codex:uuid`).

#### 12. `messages`
Performs structured cursor-based message scans across the entire corpus or within specific session boundaries.

```bash
quasar messages [--session <id>] [--project <key>] [--provider <name[,name]>] [--role <user|assistant|reasoning>] [--agent <name>] [--agent-role <role>] [--model <slug>] [--model-provider <name>] [--message-after <iso-ts>] [--message-before <iso-ts>] [--session-started-after <iso-ts>] [--session-started-before <iso-ts>] [--roots-only] [--lineage-root-session <id>] [--fields <a,b>] [--detail] [--cursor <token>] [--limit <n>] [--server <url>]
```

- `--roots-only`: Return messages only from root sessions (omits child subagents).
- `--lineage-root-session <id>`: Filter for messages belonging to a root session and its recursive subagent tree.
- `--message-after` / `--message-before`: Time range bounds for message timestamps.
- `--session-started-after` / `--session-started-before`: Time range bounds for session creation.

---

### Tool Call Forensics

#### 13. `tool-calls`
Queries and lists tool call invocations across sessions without dumping full argument/result payloads in summary mode.

```bash
quasar tool-calls [--session <id>] [--project <key>] [--provider <name[,name]>] [--tool <name>] [--agent <name>] [--agent-role <role>] [--model <slug>] [--model-provider <name>] [--fields <a,b>] [--detail] [--cursor <token>] [--limit <n>] [--server <url>]
```

- `--tool`, `--tool-name <name>`: Filter by tool function name (e.g. `exec_command`, `read_file`).
- `--tool-call`, `--tool-call-id <id>`: Filter by specific tool call identifier.

#### 14. `tool-call`
Fetches complete, unabridged tool execution forensics (input JSON, output text/JSON, status, timestamps, and error payloads) for a specific tool call ID.

```bash
quasar tool-call --id <toolCallId> [--fields <a,b>] [--server <url>]
```

---

### Trajectory Export

#### 15. `trajectory`
Exports a session trajectory in canonical Quasar format, Letta v1 format, or Harbor ATIF v1.7 format with full loss and compatibility auditing.

```bash
quasar trajectory --session <id> [--format <quasar|letta|atif>] [--exclude-reasoning] [--exclude-tool-results] [--tool-result-max-bytes <n>] [--server <url>]
```

- `--session`, `--id <sessionId>`: Session identifier to project.
- `--format <quasar|letta|atif>`: Target export format (default: `quasar`).
- `--exclude-reasoning`: Omit thinking/reasoning blocks.
- `--exclude-tool-results`: Omit tool output content.
- `--tool-result-max-bytes <n>`: Truncate large tool result payloads to `<n>` bytes with explicit content hashing.

---

### Research Export

#### 16. `research-export`
Streams reproducible, snapshot-bound NDJSON research export frames (manifest, messages, session trajectories, and checksum receipts) to an artifact file.

```bash
quasar research-export --out <path.ndjson> [--project <key>] [--provider <name[,name]>] [--session <id>] [--role <user|assistant|reasoning>] [--agent <name>] [--agent-role <role>] [--model <slug>] [--model-provider <name>] [--message-after <ts>] [--message-before <ts>] [--session-started-after <ts>] [--session-started-before <ts>] [--roots-only] [--lineage-root-session <id>] [--exclude-reasoning] [--exclude-tool-results] [--tool-result-max-bytes <n>] [--cursor <token>] [--limit <n>] [--server <url>]
```

- `--out <path>`: Destination path for the generated NDJSON artifact. Fails closed if the file already exists.
- Generates reproducible dataset shards tied to an immutable database snapshot hash.

---

### Session Enrichments

#### 17. `enrichments`
Lists derived analysis records, summaries, classifications, or thread evaluations attached to sessions.

```bash
quasar enrichments [--project <key>] [--session <id>] [--namespace <name>] [--producer <name>] [--input-hash <hash>] [--cursor <token>] [--limit <n>] [--server <url>]
```

- `--namespace <name>`: Namespaced category (e.g. `quasar.analysis.thread-summary`).
- `--producer <name>`: Producer identifier and version string (e.g. `evaluator@1.0.0`).
- `--input-hash <hash>`: Source fingerprint the enrichment was derived from.

#### 18. `enrichment-write`
Writes a namespaced session enrichment record. Re-ingesting raw source sessions will never overwrite derived enrichment records.

```bash
quasar enrichment-write <inline-json|@file|-> [--server <url>] [--ingest-token <token>]
```

Example payload:

```json
{
  "protocolVersion": "quasar.session-enrichment/v1",
  "sessionId": "codex:01950e93-9c87-7359-bb43-d9d150247656",
  "namespace": "quasar.analysis.eval",
  "schemaVersion": 1,
  "producer": "agent-evaluator@1.2.0",
  "inputHash": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
  "payload": {
    "score": 0.95,
    "verdict": "completed_task",
    "notes": "Resolved compilation issue without regressions"
  },
  "updatedAt": "2026-08-17T20:00:00.000Z"
}
```

---

### Vector Maintenance & Queue Operations

#### 19. `materialize-embedding-vectors`
Triggers or drives vector embedding computation for un-embedded messages into SQLite vector tables.

```bash
quasar materialize-embedding-vectors [--limit <n>] [--until-empty] [--max-batches <n>] [--require-provider <local|synthetic>] [--out <receipt.json>] [--server <url>]
```

- `--until-empty`: Loop continuously until all vectorless messages are materialized.
- `--max-batches <n>`: Safety limit on total batches executed.
- `--require-provider <local|synthetic>`: Gate execution requiring a specific embedding provider (e.g. local ONNX).
- `--out <path>`: Write a durable closure receipt containing execution timestamps, batches, and total tokens.

#### 20. `replay-embedding-cache`
Replays pre-computed embedding cache rows into active message vector tables.

```bash
quasar replay-embedding-cache [--limit <n>] [--server <url>]
```

#### 21. `prune-dead-letters`
Prunes resolved or obsolete dead-letter queue jobs whose underlying tasks succeeded or were superseded.

```bash
quasar prune-dead-letters [--server <url>]
```

---

### Schema & Introspection

#### 22. `schema`
Emits the strict JSON Schema definition for any Quasar protocol contract (runs locally with zero network dependencies).

```bash
quasar schema [normalized-session|mapped-session|trajectory|letta-trajectory|harbor-atif|atif-trajectory|research-export|query|response|session-enrichment]
```

#### 23. `examples`
Emits valid example JSON payloads for protocol contracts (runs locally).

```bash
quasar examples [schema-id|example-name]
```

#### 24. `version`
Outputs version and package metadata.

```bash
quasar version
```

---

## Interactive Terminal UI (TUI)

Launching `quasar` in an interactive terminal with no arguments (or running `quasar tui`) launches the high-performance OpenTUI interface.

```bash
quasar tui [--server <url>] [--smoke] [--smoke-query <query>]
```

```
┌ quasar  fusion                      42 matches  project:quasar #codex ────────────────┐
│ › project:quasar #codex model assignment█                                            │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ codex  2026-08-17  quasar  Fix model provider resolution in turn context             │
│   ...ensures that model assignment is preserved across subagent handoffs...          │
│                                                                                      │
│ codex  2026-08-16  quasar  Refactor vector embeddings batch pipeline                 │
│   ...replaces synthetic fallback with resident ONNX SIMD vector matrix...            │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Omnibox Filter Syntax

Compose real-time search filters directly within the query string:

- `@<project>` or `project:<key>`: Filter by project (e.g. `@quasar` or `project:prism`)
- `#<provider>` or `provider:<name>`: Filter by provider (e.g. `#codex` or `provider:claude`)
- `role:<user|assistant|reasoning>`: Filter by message role (e.g. `role:user`)
- Free text: Search terms evaluated by the active search engine mode.

### TUI Keymap Reference

The TUI operates with three primary focus modes without modal mode traps:

#### 1. Search Focus (Omnibox)
| Key | Action |
|---|---|
| `Any printable` | Type search text |
| `Down` / `Ctrl-N` / `Ctrl-J` | Move selection down in results list |
| `Up` / `Ctrl-P` / `Ctrl-K` | Move selection up in results list |
| `Enter` | Open transcript reader for selected session |
| `Tab` | Switch focus to results list |
| `Backspace` | Delete character |
| `Ctrl-W` | Delete preceding word |
| `Ctrl-U` | Clear omnibox query |
| `Escape` | Clear query if text present; quit if query is empty |

#### 2. List Focus (Results Browser)
| Key | Action |
|---|---|
| `j` / `Down` | Move selection down |
| `k` / `Up` | Move selection up |
| `g` | Jump to first result |
| `G` / `Shift-G` | Jump to last result |
| `1` - `9` | Jump directly to result index 1–9 |
| `Enter` / `l` / `s` | Open transcript reader for selected session |
| `t` | Toggle tool-call forensics view for session |
| `m` | Cycle search mode (`lexical` → `semantic` → `fusion`) |
| `e` | Open transcript in external `$EDITOR` |
| `y` | Yank session ID to system clipboard |
| `Y` / `Shift-Y` | Yank result snippet text to clipboard |
| `/` or `Escape` | Return focus to search omnibox |
| `?` | Toggle help overlay |
| `q` / `Ctrl-C` | Quit TUI |

#### 3. Reader Focus (Transcript & Tool Inspector)
| Key | Action |
|---|---|
| `j` / `Down` | Scroll down 1 line |
| `k` / `Up` | Scroll up 1 line |
| `Space` / `Ctrl-D` | Scroll down 12 lines (page down) |
| `b` / `Ctrl-U` | Scroll up 12 lines (page up) |
| `g` | Jump to top of transcript |
| `G` / `Shift-G` | Jump to bottom of transcript |
| `n` / `]` | Jump to next search match occurrence |
| `N` / `[` | Jump to previous search match occurrence |
| `t` | Toggle between transcript messages and tool-call view |
| `i` / `Enter` | Drill into full input/output payload for selected tool call |
| `e` | Open current transcript view in external `$EDITOR` |
| `y` | Yank session or tool call ID to clipboard |
| `Y` / `Shift-Y` | Yank visible message text to clipboard |
| `Escape` | Return to results list / omnibox |
| `q` / `Ctrl-C` | Quit TUI |

---

## Query Spec, Filters & Projections

All query-backed CLI commands (`search`, `sessions`, `messages`, `tool-calls`, `tool-call`) share the strict `quasar.query/v1` protocol specification.

### Summary vs. Detail Projections

- **Summary (`--fields ...`)**: Lightweight rows tailored for scannability and fast network transfer. Tool payloads (`input`, `output`, `error`) and raw execution contexts are omitted.
- **Detail (`--detail`)**: Full message records, complete tool arguments and outputs, execution context references, and byte size indicators.

### Pagination Contract

Query-backed commands use opaque cursor pagination:
- Pass the returned `page.nextCursor` from a response as `--cursor <token>` in the subsequent command.
- `--offset` is deliberately rejected on query-backed commands to enforce deterministic pagination across mutating datasets.

---

## JSON Output & Dual Envelope Model

The Quasar CLI adheres to a strict dual-envelope JSON output model:

### 1. Operations & Resource Commands
Commands such as `ingest`, `stats`, `session`, `projects`, `daemon`, and `materialize-embedding-vectors` return the standard envelope:

```json
{
  "ok": true,
  "command": "stats",
  "data": { ... }
}
```

On failure:

```json
{
  "ok": false,
  "command": "ingest",
  "error": {
    "type": "ConfigurationError",
    "message": "quasar ingest requires a configured local server URL",
    "details": { ... }
  }
}
```

### 2. Query Protocol Commands
Commands adhering directly to `quasar.query/v1` (`search`, `sessions`, `messages`, `tool-calls`, `tool-call`, `query`) emit top-level protocol responses:

```json
{
  "protocolVersion": "quasar.query/v1",
  "kind": "search",
  "projection": {
    "detail": "summary",
    "fields": ["sessionId", "provider", "text", "score"]
  },
  "page": {
    "returned": 1,
    "nextCursor": "eyJ2ZXJzaW9uIjoxLCJraW5kIjoic2VhcmNoIiwiYWZ0ZXIiOjEwfQ"
  },
  "items": [
    {
      "sessionId": "codex:01950e93-9c87-7359-bb43-d9d150247656",
      "provider": "codex",
      "text": "Model selection is preserved in turn context.",
      "score": 0.94
    }
  ]
}
```

---

## JSON Piping & Automation Recipes

### Search and extract top session IDs:
```bash
quasar search --query "sqlite lock issue" --mode fusion --limit 5 | jq -r '.items[].sessionId'
```

### Export an entire session transcript to Markdown:
```bash
quasar session --id "codex:01950e93-9c87-7359-bb43-d9d150247656" | jq -r '
  .data.messages[] | "### \(.role | ascii_upcase) (\(.sequence))\n\n\(.text)\n"
' > transcript.md
```

### Inspect failed tool calls across the corpus:
```bash
quasar tool-calls --detail --limit 50 | jq '
  .items[] | select(.status == "failed" or .error != null) | {toolCallId, sessionId, toolName, error}
'
```

### Stream research export shards into compressed archives:
```bash
quasar research-export --out dataset-shard-1.ndjson --project quasar --roots-only
gzip -9 dataset-shard-1.ndjson
```

### Drive vector embedding materialization to completion:
```bash
quasar materialize-embedding-vectors --until-empty --require-provider local --out ./materialize-receipt.json
cat materialize-receipt.json | jq '.data.closure'
```

---

## Environment Variables Reference

| Environment Variable | Description | Default |
|---|---|---|
| `QUASAR_SERVER_URL` | URL of the running Quasar Effect server | From `config.json` |
| `QUASAR_INGEST_TOKEN` | Secret token required for remote ingest and daemon writes | From `config.json` |
| `QUASAR_CONFIG` | Custom file path for client configuration JSON | `~/.config/quasar/config.json` |
| `QUASAR_HTTP_TIMEOUT_MS` | Client HTTP timeout in milliseconds | `60000` (60s) |
| `QUASAR_LOCAL_HOME` | Server storage root override | `~/.config/quasar/server` |
| `QUASAR_LOCAL_SQLITE` | Direct SQLite file path override | `~/.config/quasar/server/quasar.sqlite` |
| `QUASAR_DAEMON_HOME` | Root configuration and logs directory for daemon | `~/.config/quasar` |
| `QUASAR_DAEMON_BINARY` | Path to executable used for background daemon ticks | System binary |
| `QUASAR_DAEMON_INTERVAL_SECONDS` | Daemon execution frequency in seconds | `15` |
| `QUASAR_DAEMON_STALE_LOCK_SECONDS` | Duration before broken daemon locks are reclaimed | `3600` (1 hour) |
| `QUASAR_CODEX_ROOT` | Codex history directory override | `~/.codex` |
| `QUASAR_CLAUDE_ROOT` | Claude Code history directory override | `~/.claude` |
| `QUASAR_OPENCODE_ROOT` | OpenCode history directory override | `~/.local/share/opencode` |
| `QUASAR_GROK_ROOT` | Grok history directory override | `~/.grok` |
| `QUASAR_HERMES_ROOT` | Hermes history directory override | `~/.hermes` |
| `QUASAR_KIMI_ROOT` | Kimi history directory override | `~/.kimi` |
| `QUASAR_ANTIGRAVITY_ROOT` | Antigravity history directory override | `~/.gemini/antigravity-cli` |
| `QUASAR_OMP_ROOT` | OMP history directory override | `~/.omp` |
| `QUASAR_PI_ROOT` | Pi history directory override | `~/.pi` |
| `QUASAR_PRIME_ROOT` | Prime history directory override | `~/.prime` |
| `QUASAR_CURSOR_ROOT` | Cursor history directory override | `~/Library/Application Support/Cursor` |
| `QUASAR_DEVIN_ROOT` | Devin history directory override | `~/.devin` |
| `QUASAR_AMP_ROOT` | Amp history directory override | `~/.amp` |
