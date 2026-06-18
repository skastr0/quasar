# Quasar — Effect Local Server Plan

Date: 2026-06-18.
Status: **canonical direction**. The production path is an Effect-owned local server.

## Product sentence

Quasar ingests local AI-agent session histories, normalizes them into one local truth
store, and serves deep session inspection plus lexical/vector/fusion search to agents
through a CLI, MCP/control surfaces, and a local HTTP server reachable on the private
Tailscale mesh.

## Non-negotiable data reality

The corpus is small in database terms and large only in workflow pain terms:

- approximately 1.8 GB raw source history;
- approximately 650 MB of product text;
- approximately 2,360 sessions in the measured five-provider estate;
- no legitimate session value over 1 MB in the measured corpus;
- provider garbage is rejected at the boundary with diagnostics, never accommodated by
  invented storage clamps or reconstruction layers.

This system is local infrastructure for one machine estate. It should be boring:
read files and local SQLite databases, write a local SQLite truth store, maintain a
local LanceDB search index, call Gemini for embeddings with a cache, and answer agent
queries quickly.

## Canonical ownership

| Surface | Owner | Rule |
| --- | --- | --- |
| Normalized session truth | SQLite | Authoritative OLTP store: projects, sessions, messages, tool calls, ingest runs, queue state, embedding cache metadata. |
| Search rows and indexes | LanceDB | Derived from SQLite; disposable and rebuildable. Owns lexical/vector/fusion search indexes. |
| Embedding calls | Effect worker + Gemini client | Asynchronous, cached by model and normalized content hash, retryable, never required for lexical search. |
| Orchestration | Effect runtime | Services/layers, one ManagedRuntime, bounded worker fibers, structured errors, status visibility. |
| Deployment | Docker on the Mac mini | Persistent volumes for SQLite/LanceDB/logs, Tailscale-reachable HTTP port, clean start/stop/restart behavior. |

## Domain model

The product model stays the same because it was the hard-won good part of the prior
work. Provider knowledge remains inside adapters; the shared domain owns normalized
types only.

```text
Project
  projectKey, displayName, aliases, rawPaths

Session
  sessionId, projectKey, provider, agentName, title,
  startedAt, updatedAt, sourcePath, sourceFingerprint,
  messageCount, toolCallCount

Message
  sessionId, seq, role(user|assistant|reasoning), text, ts, projectKey

ToolCall
  sessionId, seq, toolName, status, inputText, outputText,
  startedAt, completedAt, projectKey, provider
```

`messages` is the search source. `toolCalls` is the structural retrieval surface:
stored in full, queryable by session order or project/tool name, and not embedded or
search-indexed by default.

## Service graph

The server is organized around Effect services and layers rather than framework-global
singletons.

```diagram
╭────────────────────╮
│ Effect HTTP Server │
╰─────────┬──────────╯
          │
          ▼
╭────────────────────╮      ╭────────────────────╮
│ Control API        │─────▶│ Ingest Service     │
│ search/read/status │      │ provider adapters  │
╰─────────┬──────────╯      ╰─────────┬──────────╯
          │                           │
          ▼                           ▼
╭────────────────────╮      ╭────────────────────╮
│ Search Service     │◀────▶│ SQLite Store       │
│ LanceDB derived    │      │ truth + queues     │
╰─────────┬──────────╯      ╰─────────┬──────────╯
          │                           │
          ▼                           ▼
╭────────────────────╮      ╭────────────────────╮
│ LanceDB search     │      │ Worker Queue       │
│ search.lance       │      │ index/embed/maint  │
╰────────────────────╯      ╰─────────┬──────────╯
                                      │
                                      ▼
                           ╭────────────────────╮
                           │ Gemini Embeddings  │
                           │ cache + backfill   │
                           ╰────────────────────╯
```

Required services:

- `ConfigService`: paths, bind host/port, worker concurrency, provider roots,
  embedding settings, maintenance cadence.
- `SqliteStore`: migrations, idempotent writes, paginated reads, tool-call lookups,
  ingest run ledger, embedding cache tables.
- `DurableQueue`: SQLite-backed jobs with leasing, retries, backoff, stale lease
  recovery, and idempotent enqueue keys.
- `IngestService`: provider discovery/parse/map/redact/write/report, then enqueue
  downstream jobs.
- `SearchService`: LanceDB open/create, row upsert, lexical search, vector/fusion
  search, stats, orphan cleanup.
- `EmbeddingService`: Gemini batching, content-hash cache, vector writes, failure
  diagnostics.
- `MaintenanceService`: index creation, optimize/cleanup, freshness reconciliation.
- `WorkerSupervisor`: starts and stops bounded fibers, exposes worker status, and
  keeps one runtime-owned service graph.

## SQLite schema responsibilities

SQLite is both the truth store and the first durable queue. Do not introduce Redis,
Kafka, or another queue until a measured local workload proves SQLite insufficient.

Minimum tables:

- `projects`
- `sessions`
- `messages`
- `tool_calls`
- `ingest_runs`
- `ingest_session_results`
- `jobs`
- `embedding_cache`
- `search_freshness`
- `maintenance_runs`

Queue rows should carry:

- `kind`
- stable idempotency key
- payload JSON
- `status`
- attempts
- `leased_by`
- `lease_until`
- `next_run_at`
- last error
- timestamps

The queue is allowed to hold derived-work intent. It is not allowed to become a second
source of truth for sessions or messages.

## Ingest flow

```diagram
╭──────────────╮   ╭────────────╮   ╭────────────╮   ╭──────────────╮
│ Source roots │──▶│ Adapters   │──▶│ Normalize  │──▶│ Redact text  │
╰──────────────╯   ╰────────────╯   ╰────────────╯   ╰──────┬───────╯
                                                            │
                                                            ▼
╭──────────────╮   ╭────────────╮   ╭────────────╮   ╭──────────────╮
│ Run report   │◀──│ Enqueue    │◀──│ SQLite     │◀──│ Boundary     │
│ ok/skip/fail │   │ jobs       │   │ upsert     │   │ diagnostics  │
╰──────────────╯   ╰────────────╯   ╰────────────╯   ╰──────────────╯
```

Rules:

- adapters stream; they do not materialize the whole corpus unnecessarily;
- every text surface crosses `redactSensitive` before storage;
- unchanged `sourceFingerprint` can skip a session;
- changed sessions are replaced idempotently inside SQLite;
- session-level failure produces a structured diagnostic and does not poison the run;
- successful session writes enqueue index and embedding work;
- embedding calls are never on the critical path for lexical search readiness.

## Search flow

LanceDB is derived. Rebuild is always legal from SQLite truth.

```text
SQLite messages ──index jobs──▶ LanceDB rows ──maintenance──▶ FTS/vector indexes
SQLite embedding_cache ───────▶ LanceDB vectors
```

Search modes:

- `lexical`: available after message rows are indexed;
- `semantic`: available only when embeddings exist for candidate rows;
- `fusion`: combines lexical and vector results when vector readiness is sufficient;
- `tool-call retrieval`: served from SQLite, not LanceDB.

Maintenance is explicit: create missing indexes, optimize/cleanup fragments, report row
counts/index stats/disk sizes, and reconcile freshness between SQLite and LanceDB.

## HTTP and CLI surface

The HTTP API should be boring JSON:

- health/readiness/status;
- ingest plan/run/status;
- project list;
- session list/read with pagination;
- tool-call list/detail;
- search lexical/semantic/fusion;
- index, embedding, queue, and maintenance stats.

The CLI may run local commands directly for development, but production commands should
also be able to act as a thin client to the local server. Responses use typed JSON
envelopes and explicit error tags.

## Docker and Tailscale deployment

The production deployment target is Docker on the Mac mini.

Requirements:

- persistent volumes for SQLite, LanceDB, logs, and optional backups;
- read-only or explicitly scoped mounts for source history roots;
- bind to an interface and port reachable through Tailscale;
- support direct Tailscale IP access as the reliable baseline;
- optionally support MagicDNS if verified in the local mesh;
- inject secrets through environment or mounted secret files, never committed values;
- provide start/stop/restart/log/status commands;
- leave Tower Control and Booth Control sibling services untouched.

## Operational cutover

Cutover is staged:

1. Build and test the local server against a tiny fixture corpus.
2. Prove SQLite ingest and lexical search locally.
3. Prove embedding cache and fusion search locally.
4. Run in Docker with persistent volumes.
5. Verify Tailscale reachability by IP.
6. Retire the old Quasar service while leaving sibling projects untouched.
7. Re-ingest the full corpus from source histories.
8. Write proof under `docs/proofs/`.

Rollback is restoring the previous Quasar service and pointing old clients at it. The
new path must not destroy that option during the first migration.

## Validation ladder

Each implementation slice should use the narrowest check that proves its claim:

- typecheck for service contracts;
- unit tests for SQLite migrations, queue leasing, idempotent writes, and cache hits;
- integration smoke for ingest → SQLite → LanceDB lexical search;
- embedding smoke with cached retry behavior;
- Docker/Tailscale smoke from another mesh client when available;
- full proof with real corpus counts and sample search results.

Root validation remains `bun run typecheck && bun run test` until the package defines a
stronger local-server-specific verification command.

## Current migration sequence

Tower tracks the Effect migration as the next Forge sequence:

1. Specify this architecture.
2. Stand up the Effect Platform server package.
3. Build SQLite truth store and migrations.
4. Build SQLite durable queue.
5. Port ingestion to the local server.
6. Wrap LanceDB as a derived search service.
7. Add embedding cache and workers.
8. Expose local search HTTP and CLI APIs.
9. Add LanceDB maintenance and freshness workers.
10. Add worker orchestration and observability.
11. Containerize for Docker and Tailscale.
12. Retire the old runtime without deleting data.
13. Produce full-corpus ingest/search proof.
