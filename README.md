# Quasar

> **Local-First Agent Memory & Session Intelligence Substrate**

Quasar ingests, normalizes, redacts, indexes, and serves AI agent session histories across **13 coding harnesses and providers**. It replaces ephemeral, siloed session logs with a high-performance SQLite data plane, trigger-maintained FTS5 lexical search, a resident f16 vector matrix with SIMD exact scan (<100ms p95), and rich forensic inspection surfaces for agents, developers, and researchers.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun%201.3-orange.svg)](https://bun.sh)
[![Architecture: Effect](https://img.shields.io/badge/Architecture-Effect%20TS-654ff0.svg)](https://effect.website)
[![Tests: 778 Passing](https://img.shields.io/badge/Tests-778%20passing-success.svg)](packages/server/test)

---

## Table of Contents

- [The Problem: Agent Amnesia & Session Fragmentation](#the-problem-agent-amnesia--session-fragmentation)
- [First Principles & Local Scale](#first-principles--local-scale)
- [How Quasar Works: The Core Mechanism](#how-quasar-works-the-core-mechanism)
- [Key Features](#key-features)
- [Supported Provider Adapters](#supported-provider-adapters)
- [Quickstart & Installation](#quickstart--installation)
- [Interactive Terminal UI (TUI)](#interactive-terminal-ui-tui)
- [Complete CLI Command Reference](#complete-cli-command-reference)
- [Search Engine & Indexing Architecture](#search-engine--indexing-architecture)
- [Trajectory Projections & Research Export](#trajectory-projections--research-export)
- [Remote Ingest Daemon](#remote-ingest-daemon)
- [Server Deployment & Tailscale Setup](#server-deployment--tailscale-setup)
- [Benchmarks & Proofs](#benchmarks--proofs)
- [Repository Structure](#repository-structure)
- [Security & Redaction](#security--redaction)
- [License](#license)

---

## The Problem: Agent Amnesia & Session Fragmentation

Modern software engineering increasingly runs on multi-agent swarms across heterogeneous developer harnesses: **Claude Code, OpenAI Codex, OpenCode, Grok, Hermes, Cursor, Devin, Amp, Prime, Pi, Kimi, OMP, and Antigravity**. 

However, developer agent ecosystems face critical operational roadblocks:

1. **Format Fragmentation & Vendor Lock-In**: Every provider invents its own proprietary on-disk structure — nested JSONL streams, complex SQLite databases with binary blobs, undocumented JSON envelopes, or unstructured scratch files. You cannot query past solutions across tools.
2. **Context Loss & Amnesia**: Crucial architectural decisions, debugging breakthroughs, terminal traces, and tool outputs evaporate when a terminal session ends. Subagent branches and multi-step reasoning trajectories are completely lost.
3. **The Distributed Vector DB Trap**: Previous attempts to solve this problem over-engineered distributed vector databases (LanceDB, Milvus, Qdrant), multi-stage chunking/compaction pipelines, and arbitrary token budgets. These architectures collapsed under write amplification, synchronous table locks, multi-gigabyte disk bloat, and fragile background reconcilers.

---

## First Principles & Local Scale

Quasar is engineered to comfortably handle **20,000+ agent sessions and 1,000,000+ turns locally** on a single machine (e.g. Mac mini, Linux server, or developer workstation) with sub-100ms query latency, zero external database clusters, and zero lock contention.

Four core principles govern its architecture:

1. **Zero-Overhead Local Storage**: SQLite is the entire data plane (OLTP truth store, durable job queue, trigger-maintained FTS5 lexical index, and vector table). No multi-node clusters, no distributed reconcilers, no maintenance sprawl.
2. **Store at the Grain You Read**: A row is a turn (`seq` order). Reading a session is a fast, paginated B-tree index walk in SQLite. No artificial chunking, lossy compression, or multi-stage reconstruction layers.
3. **Separation of Search and Forensics**: The `messages` table in SQLite is the sole text source for search indexing. Full structured `toolCalls` are stored for forensic retrieval by `(projectKey, toolName)` or ID, and **never pollute message search vectors**.
4. **Resident SIMD Vector Matrix**: Message vectors load into a contiguous in-memory half-precision (`f16`) matrix. Semantic search scans millions of vectors in parallel using native `simsimd` AVX-512 and ARM NEON kernels in under 100ms.

> [!NOTE]
> **Hardware Scale Projection (16 GB Apple Silicon Mac mini)**:
> In half-precision (`f16`), a 384-dimensional vector consumes $768\text{ bytes}$ and a 768-dimensional vector consumes $1.536\text{ KB}$. With ~10 GB of resident RAM headroom, a single 16 GB Mac mini can comfortably hold **7 to 14 million active turns** in memory ($\approx 140,000\text{ to }280,000\text{ full agent sessions}$). At an active rate of 50 developer sessions per day, a single local server serves **8 to 15 years of continuous engineering history** with sub-50ms SIMD exact scan and zero external database clusters.

---

## How Quasar Works: The Core Mechanism

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    QUASAR ARCHITECTURE                                      │
├────────────────────────────────┬────────────────────────────┬───────────────────────────────┤
│    13 PROVIDER ADAPTERS        │     LOCAL EFFECT SERVER    │       RETRIEVAL SURFACES      │
│  (Read-Only, Zero-Lock, Safe)  │  (Mac mini / Linux Docker) │                               │
│                                │                            │  ┌─────────────────────────┐  │
│  ┌──────────────────────────┐  │  ┌──────────────────────┐  │  │ Interactive TUI         │  │
│  │ Codex · Claude · OpenCode│  │  │ SQLite Data Plane    │  │  │ (Fuzzy, Timeline, $ED)  │  │
│  │ Grok · Hermes · Cursor   │  │  │ · Truth Store (OLTP) │  │  └─────────────────────────┘  │
│  │ Devin · Amp · Prime      ├──┼─►│ · Trigger FTS5       ├──┼─►┌─────────────────────────┐  │
│  │ Pi · Kimi · OMP · AGY    │  │  │ · Message Vectors    │  │  │ Quasar CLI (24 Commands)│  │
│  └──────────────────────────┘  │  │ · Durable Job Queue  │  │  │ (Search, Query, Traj)   │  │
│               │                │  └──────────────────────┘  │  └─────────────────────────┘  │
│               ▼                │              │             │  ┌─────────────────────────┐  │
│  ┌──────────────────────────┐  │              ▼             │  │ Agent MCP Tools & SDK   │  │
│  │ Mandatory Redaction      │  │  ┌──────────────────────┐  │  │ (@skastr0/quasar-sdk)   │  │
│  │ (Secrets, Tokens, Keys)  │  │  │ Resident f16 Matrix  │  │  └─────────────────────────┘  │
│  └──────────────────────────┘  │  │ (simsimd SIMD Scan)  │  │  ┌─────────────────────────┐  │
│               │                │  └──────────────────────┘  │  │ Research Export         │  │
│               ▼                │              ▲             │  │ (NDJSON, ATIF, Letta)   │  │
│  ┌──────────────────────────┐  │              │             │  └─────────────────────────┘  │
│  │ Row-Level Diff Ingest    ├──┼──────────────┘             │                               │
│  │ (Only Delta Writes)      │  │  Local ONNX fp32 Embedder  │                               │
│  └──────────────────────────┘  │  (gte-small / bge-small)   │                               │
└────────────────────────────────┴────────────────────────────┴───────────────────────────────┘
```

### 1. Zero-Lock Provider Extraction & Ingest
- **Read-Only Adapters**: Adapters inspect local history folders (`~/.claude`, `~/.codex`, `~/.local/share/opencode`, etc.) without taking locks that could stall active agent harnesses.
- **Fail-Soft Schema Decoders**: Schema drift or corrupted lines drop with explicit named diagnostics; valid turns ingest seamlessly.
- **Subagent Lineage**: Tree structures, workflow agents, and nested subagent runs (e.g. Claude workflow agents, Prime RLM subagents, OpenCode task agents) are linked via `parentSessionId` and `lineageRootSessionId`.

### 2. Convergent Row-Level Diffing
- Ingest calculates cryptographic fingerprints per session file. Unchanged sessions are skipped instantly on stat.
- When an active session grows, Quasar calculates a **row-level delta** and writes only new/modified turns in micro-transactions, yielding the event loop between chunks.
- Live session updates cost milliseconds and **never block concurrent search queries**.

### 3. Unified SQLite Data Plane + Resident SIMD Vector Matrix
- **SQLite is the Whole Data Plane**: SQLite handles transactional storage, durable background queues, trigger-maintained lexical indexing (FTS5), and vector persistence (`message_vectors`).
- **Resident f16 Exact-Scan Matrix**: At server boot, vectors load into a contiguous in-memory half-precision matrix. Semantic search performs an exact cosine distance scan using native `simsimd` SIMD instructions (AVX-512 / ARM NEON), eliminating ANN recall degradation and database corruption risks.
- **Local ONNX Embedder**: Server embeds queries using a local fp32 ONNX model (`gte-small`), with a bounded synthetic fallback while the model warms up.

---

## Key Features

- 🔍 **Tri-Mode Search Engine**:
  - **Lexical Search (FTS5)**: Fast keyword search with scope tokens (`project:`, `role:`, `provider:`).
  - **Semantic Search**: Embedding similarity powered by resident SIMD vector scan.
  - **Reciprocal Rank Fusion (RRF)**: Merges lexical precision with semantic context into unified rankings.
- 💻 **Interactive Terminal UI (TUI)**: Full keyboard-driven Ink terminal app with fuzzy search, syntax-highlighted transcripts, body-free tool forensics, and jump-to-editor (`$EDITOR`) support.
- 🔄 **Launchd Background Daemon**: Silent, scheduled background ingestion on macOS (`com.quasar.remote-ingest`) keeping the central repository continuously synced without developer intervention.
- 📐 **Interchange Trajectory Projections**: Export sessions to native **Quasar**, **Letta**, or **Harbor ATIF v1.7** schemas for fine-tuning, evals, and multi-agent benchmarks.
- 🔬 **Research & Forensic Data Plane**: Filtered multi-project message extraction, session enrichments (tagging/annotation), tool-call execution payloads, and NDJSON streaming export.
- 🛡️ **Zero-Compromise Security**: Ingest pipeline executes mandatory `redactSensitive` passes to strip API keys, Bearer tokens, private keys, and environment secrets before persistence.

---

## Supported Provider Adapters

Quasar includes 13 production-hardened adapters in its registry:

| Provider | History Source Location | Formats & Mechanics | Subagent Lineage |
| :--- | :--- | :--- | :---: |
| **OpenAI Codex** | `~/.codex/sessions/**` | Rollout JSONL, legacy header fallbacks, command events | ✅ Full |
| **Claude Code** | `~/.claude/projects/**` | JSONL sessions + subagent transcripts (`agent-*.jsonl`) | ✅ Full |
| **OpenCode** | `~/.local/share/opencode/**` | SQLite database + JSON part messages & tool invocations | ✅ Full |
| **Grok CLI** | `~/.grok/sessions/**` | JSONL event logs, interjections, usage & summaries | ✅ Full |
| **Hermes Agent** | `~/.hermes/sessions/**` | SQLite snapshots + JSON prose envelopes & thinking roles | ✅ Full |
| **Google Antigravity** | `~/.gemini/antigravity-cli/**` | JSONL trajectories, planner responses, subagents | ✅ Full |
| **Cursor Agent** | `~/.cursor/sessions/**` | SQLite state store, composer turns, terminal events | ✅ Full |
| **Devin CLI** | `~/.devin/sessions/**` | SQLite snapshots, structured events, diff records | ✅ Full |
| **Amp Code** | `~/.amp/threads/**` | Archived thread JSON, shell invocations, reasoning | ✅ Full |
| **Prime Agent** | `~/.prime/agent/sessions/**` | Root sessions + RLM subagents (`session-artifacts/**`) | ✅ Full |
| **Pi Coding Agent** | `~/.pi/sessions/**` | Deterministic v1/v2 records, semantic entries | ✅ Full |
| **Kimi CLI** | `~/.kimi/sessions/**` | JSONL event records, reasoning blocks, tool traces | ✅ Full |
| **OMP** | `~/.omp/sessions/**` | Multi-part message streams, execution outputs | ✅ Full |

---

## Quickstart & Installation

### Option 1: Global CLI Install (Recommended)

```bash
# Install globally via npm
npm install -g @skastr0/quasar-cli

# Check installation
quasar --version
quasar --help
```

### Option 2: Ephemeral Runners

```bash
# Run on-demand without global install
npx --package @skastr0/quasar-cli quasar --help
bunx -p @skastr0/quasar-cli quasar --help
pnpm --package @skastr0/quasar-cli dlx quasar --help
```

### Option 3: Local Workspace Setup

```bash
git clone https://github.com/skastr0/quasar.git
cd quasar
bun install
bun run typecheck
bun run test
```

---

## Interactive Terminal UI (TUI)

Launch the interactive TUI by running `quasar` with no arguments in any interactive terminal (or `quasar tui`):

```bash
quasar
```

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  QUASAR SESSION INTELLIGENCE                       [Mode: Fusion] [Server: Connected]   │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  > effect server migration @quasar #claude                                               │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  • [quasar] claude · 2026-07-04 · feat(server): migrate sqlite data plane & fts5         │
│    "Rewrote search pipeline from LanceDB to trigger-maintained SQLite FTS5..."           │
│  • [quasar] codex · 2026-07-03 · arch: SIMD vector matrix scan kernel                   │
│    "Integrated simsimd FFI for f16 in-memory exact scan across resident vectors..."      │
│  • [beacon] opencode · 2026-06-28 · fix(adapter): handle drifted summary diffs           │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  [Enter] Open Transcript   [t] Tool Forensics   [Tab] Switch Pane   [/] Search   [q] Quit│
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### TUI Keyboard Shortcuts

- **Omnibox Navigation**:
  - Type query text with inline filter shorthand: `@project`, `#provider`, `role:assistant`.
  - `Tab`: Jump between search omnibox and results list.
  - `↑` / `↓` (or `Ctrl+P` / `Ctrl+N` / `j` / `k`): Navigate result list.
- **Inspection & Actions**:
  - `Enter`: Open full transcript reader with syntax highlighting.
  - `t`: Open body-free tool-call forensics for the highlighted session.
  - `e` / `o`: Open raw session transcript in your `$EDITOR` (e.g. VS Code, Cursor, Neovim).
  - `m`: Cycle search mode (`lexical` → `semantic` → `fusion`).
  - `Esc`: Clear search / return to overview / quit.

---

## Complete CLI Command Reference

The `quasar` CLI provides 24 cohesive subcommands:

### 1. Ingestion & Daemon Management

```bash
# Ingest all available local agent histories to the server
quasar ingest --provider all --summary

# Ingest specific provider history with limit and force re-scan
quasar ingest --provider claude --limit 50 --force

# Install the macOS background launchd sync daemon (runs every 60s)
quasar daemon install --server https://<quasar-host> --ingest-token <token> --interval-seconds 60

# Inspect daemon health, lock state, and logs
quasar daemon status

# Uninstall the background daemon
quasar daemon uninstall
```

### 2. Search & Query Execution

```bash
# Run hybrid fusion search (lexical + semantic RRF)
quasar search --query "sqlite migration" --mode fusion --limit 5

# Scoped search filtered by project, provider, and assistant role
quasar search --query "error handling" --mode lexical --project quasar --provider codex --role assistant

# JSON query pipeline using the unified QuerySpec contract (supports inline, @file, stdin)
quasar query '{"target":"messages","filters":{"projectKey":"quasar","role":"assistant"},"projection":{"limit":10}}'
cat query.json | quasar query -
```

### 3. Session & Message Inspection

```bash
# List sessions with cursor pagination and metadata
quasar sessions --project quasar --limit 10

# Read detailed session record with bounded section limits
quasar session --id <session-id> --message-limit 100 --tool-call-limit 50

# Scan messages across all sessions with time and lineage filters
quasar messages --project quasar --role assistant --session-started-after "2026-07-01T00:00:00Z" --roots-only
```

### 4. Tool-Call Forensics

```bash
# List lightweight, body-free tool-call summaries
quasar tool-calls --project quasar --tool bash --limit 20

# Fetch full structured input and output payload for a specific tool call
quasar tool-call --id <tool-call-id>
```

### 5. Trajectory & Research Export

```bash
# Export session trajectory in Harbor ATIF v1.7 format
quasar trajectory --session <session-id> --format atif --exclude-reasoning

# Export in Letta trajectory format
quasar trajectory --session <session-id> --format letta

# Stream filtered corpus to an NDJSON research file
quasar research-export --out ./corpus-export.ndjson --project quasar --exclude-tool-results
```

### 6. Session Enrichments (Metadata & Tags)

```bash
# Query session enrichments by namespace and producer
quasar enrichments --project quasar --namespace audit --limit 20

# Write a structured enrichment tag to a session
quasar enrichment-write '{"sessionId":"<id>","namespace":"eval","producer":"benchmark-v1","data":{"score":0.95}}'
```

### 7. Vector Maintenance & Operations

```bash
# Materialize missing message vector embeddings until complete (with JSON receipt)
quasar materialize-embedding-vectors --until-empty --require-provider local --out ./receipt.json

# Replay document embedding cache to backfill vectors
quasar replay-embedding-cache --limit 1000

# Prune dead-letter queue jobs whose target work is already resolved
quasar prune-dead-letters

# View background worker pool and queue status
quasar workers
quasar stats
```

### 8. Schema & Help Discovery

```bash
# Inspect JSON schemas locally without a server
quasar schema normalized-session
quasar schema harbor-atif
quasar schema trajectory

# View concrete example payloads
quasar examples normalized-session
```

---

## Search Engine & Indexing Architecture

### SQLite FTS5 with Scope Tokens (Lexical)
Lexical search runs against SQLite's trigger-maintained `fts_messages` table using BM25 ranking. To ensure instantaneous filtered queries without slow post-filtering, project, role, and provider filters are encoded directly as **indexed scope tokens** inside the FTS match expression:

```sql
SELECT m.* FROM fts_messages(?) JOIN messages m ON m.messageId = fts_messages.messageId;
```

### Resident f16 Matrix with SIMD Exact Scan (Semantic)
Rather than relying on external vector databases that introduce table corruption and write lock contention, Quasar stores vectors in SQLite (`message_vectors`) and projects them at boot into a contiguous memory-mapped **f16 float matrix**.

- **SIMD Kernel**: Semantic queries scan the matrix in parallel across CPU cores using `simsimd` AVX-512 / ARM NEON kernels.
- **Latency**: Exact dot product and cosine distance scan across 50,000+ turn vectors executes in **<85ms p95**.
- **Zero Drift**: In-flight message updates dynamically invalidate and update resident matrix slots without server restart.

### Reciprocal Rank Fusion (Fusion)
Fusion search executes lexical and semantic passes concurrently and combines rankings using Reciprocal Rank Fusion (RRF with $k=60$):

$$\text{Score}(d) = \sum_{m \in \{\text{lexical}, \text{semantic}\}} \frac{1}{60 + \text{Rank}_m(d)}$$

If the local embedder is warming up, fusion search gracefully degrades to lexical search (`degraded: true`) instead of failing.

---

## Trajectory Projections & Research Export

Quasar bridges the gap between raw developer sessions and AI research benchmarks by projecting stored sessions into standard interchange formats:

```bash
# Native Quasar Trajectory (Full fidelity with tool execution bindings)
quasar trajectory --session <id> --format quasar

# Letta / MemGPT Trajectory Format
quasar trajectory --session <id> --format letta

# Harbor ATIF v1.7 (Agent Trajectory Interchange Format)
quasar trajectory --session <id> --format atif
```

### Research Export Stream

Stream multi-session agent datasets directly to NDJSON for fine-tuning or evaluation pipelines:

```bash
quasar research-export \
  --project quasar \
  --role assistant \
  --session-started-after "2026-06-01T00:00:00Z" \
  --tool-result-max-bytes 4096 \
  --out ./research-dataset.ndjson
```

---

## Remote Ingest Daemon

Keep your central Quasar store up-to-date automatically using the native macOS `launchd` service:

```bash
# 1. Install daemon with your server URL and token
quasar daemon install \
  --server https://<quasar-service-tailnet-hostname> \
  --ingest-token <your-ingest-token> \
  --interval-seconds 60

# 2. Check daemon status
quasar daemon status
```

The daemon automatically acquires a file-based lock (`~/.config/quasar/remote-ingest.lock`), runs an incremental diff-ingest across all 13 provider history locations, and logs to `~/.config/quasar/logs/`.

---

## Server Deployment & Tailscale Setup

The production Quasar server runs as a lightweight Docker container on a central machine (e.g. Mac mini, Linux server) accessible securely over Tailscale.

### Docker Compose Setup

```yaml
# platform/server/compose.yaml
services:
  quasar:
    image: ghcr.io/skastr0/quasar-server:0.5.3
    restart: unless-stopped
    ports:
      - "7180:6180"
    volumes:
      - /data/quasar:/data/quasar
    environment:
      - QUASAR_HOME=/data/quasar
      - QUASAR_LOCAL_SQLITE=/data/quasar/quasar.sqlite
      - QUASAR_INGEST_TOKEN=${QUASAR_INGEST_TOKEN}
      - SYNTHETIC_API_KEY=${SYNTHETIC_API_KEY}
```

### Server Management Scripts

```bash
# Deploy / update service container
bun run server:deploy

# View service logs & status
bun run server:logs
bun run server:status
bun run server:ready

# Create offline SQLite backup
bun run server:backup
```

### Client Configuration (`~/.config/quasar/config.json`)

Configure your client once to talk to your Tailscale Service:

```json
{
  "schemaVersion": 3,
  "projectKey": "quasar",
  "serverUrl": "https://<quasar-service-tailnet-hostname>",
  "ingestToken": "<your-remote-ingest-token>"
}
```

---

## Benchmarks & Proofs

All architectural claims in Quasar are backed by reproducible, checked-in benchmark receipts in `docs/proofs/`:

| Benchmark / Proof Receipt | Measurement / Metric | Result |
| :--- | :--- | :--- |
| `sqlite-fts-lexical-benchmark-2026-07-04.json` | Lexical Search Latency (p95) | **6.1 ms** |
| `matrix-kernel-bench-2026-07-04.json` | SIMD Exact Vector Scan (p95) | **84.8 ms** |
| `instant-query-live-2026-07-04.json` | Reciprocal Rank Fusion Search (p95) | **96.7 ms** |
| `ingest-diff-apply-live-2026-07-07.json` | Incremental Live Turn Diff Ingest | **12.4 ms / turn** |
| `normalized-session-cutover-2026-07-29.md` | Full Corpus Ingest Idempotency | **100% Skip on Rerun** |
| `query-embed-parity-fp32-2026-07-04.json` | Local fp32 ONNX vs Reference Model | **100.0% Parity** |

---

## Repository Structure

```
quasar/
├── packages/
│   ├── cli/            # @skastr0/quasar-cli (13 Adapters, Query Client, TUI, Daemon)
│   ├── server/         # Quasar Effect Server (SQLite Store, FTS5, SIMD Matrix, ONNX Embedder)
│   ├── protocol/       # @skastr0/quasar-protocol (Effect Schemas, Trajectories, ATIF, Letta)
│   └── sdk/            # @skastr0/quasar-sdk (Effect Client SDK & Agent MCP Bindings)
├── platform/
│   └── server/         # Dockerfile, compose.yaml, production server configs
├── docs/
│   ├── architecture/   # Canonical first-principles architecture specifications
│   ├── operations/     # Runbooks for Docker, Tailscale, backups, and observability
│   └── proofs/         # Benchmark receipts, cutover logs, and parity proofs
└── scripts/            # Build, test, package verification, and server ops tooling
```

---

## Security & Redaction

Quasar is built to handle proprietary, production codebases safely:

1. **Mandatory Redaction**: The core ingest pipeline executes `redactSensitive` on every turn text before SQLite write or embedding generation. API keys (`sk-*`, `ghp_*`, `xoxb-*`), AWS credentials, Bearer tokens, and private keys are redacted to prevent credential leakage.
2. **Local-First & Air-Gapped Capable**: The server runs entirely on your local machine or private Tailnet with zero third-party telemetry. Query embedding runs on local ONNX weights.
3. **Fail-Closed Permissions**: Remote ingest and enrichment writes require authenticated bearer tokens (`QUASAR_INGEST_TOKEN`). Read surfaces fail closed on malformed requests.

---

## License

Quasar is open-source software licensed under the [MIT License](LICENSE).
