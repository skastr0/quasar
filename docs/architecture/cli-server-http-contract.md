# CLI ⇄ Server HTTP Wire Contract

This document specifies the binding wire contract between the Quasar **CLI** (the sole ingest writer) and the Quasar **server** (storage, search substrate, and serving APIs). `@skastr0/quasar-protocol` is the single source of truth for versioned Effect Schemas and TypeScript types consumed across packages.

---

## Architectural Principles

1. **Ingestion is CLI-Side Only:** The server never scans, discovers, parses, or watches provider history roots. All filesystem discovery, parsing, normalization, redaction (`redactSensitive`), and fingerprinting happen on the client machine. The CLI POSTs pre-normalized `MappedSession` envelopes to the server over HTTP.
2. **Server is Storage, Search, and Serving:** The server validates incoming wire envelopes against strict schema invariants, performs row-level diffing transactional upserts into SQLite (`/data/quasar/quasar.sqlite`), enqueues downstream vector embedding jobs into `durable_queue`, maintains the FTS5 lexical index, and serves queries and projections.
3. **No In-Process Server in CLI:** The CLI never embeds SQLite, the search substrate, or the server runtime directly (enforced by `packages/cli/test/package-boundary.test.ts`). The server never imports CLI or adapter parser code (enforced by `packages/server/test/boundary.test.ts`).
4. **Strict Boundary Validation:** The server fails closed before writing any rows if authentication fails, protocol version mismatches, or payloads violate referential integrity.

---

## Endpoint Catalog

### Ingest Endpoints (Write Plane)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/ingest/fingerprint` | Required | Probe `(sessionId, sourceFingerprint, normalizationVersion)` freshness to skip unchanged files. |
| `POST` | `/ingest/run` | Required | Record the start, progress, or completion lifecycle of an ingest run (`IngestRunRow`). |
| `POST` | `/ingest/session` | Required | Ingest one normalized `MappedSession` with row-diffing upserts. Accepts `?force=true`. |

### Resource Endpoints (Read Plane)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/projects` | None | List project identities with bounded pagination (`limit`, `offset`). |
| `GET` | `/sessions` | None | List source-rich sessions with scoped metadata filters and bounded pagination. |
| `GET` | `/session-detail` | None | Read rich bounded sections of a session (messages, tool calls, events, usage, edges, artifacts, contexts). |
| `GET` | `/messages` | None | Read messages in deterministic sequence order with cursor-based or snapshot pagination. |
| `GET` | `/tool-calls` | None | List body-free tool-call summaries with scoped metadata filters. |
| `GET` | `/tool-call` | None | Read one complete tool call including full `input` and `output` payloads by `id`. |
| `GET` | `/ingest-runs` | None | List historical ingest runs with optional `status` filter and pagination. |
| `GET` | `/ingest-run` | None | Read details of a specific ingest run by `runId`. |
| `GET` | `/session-enrichments`| None | Read namespaced AI-derived enrichments for a session with opaque cursor pagination. |
| `POST` | `/session-enrichments`| Required | Upsert a namespaced session enrichment envelope (`quasar.session-enrichment/v1`). |

### Search Endpoints (Query Plane)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/search/lexical` | None | Trigger-maintained FTS5 scoped lexical search (BM25 ranking). |
| `GET` | `/search/semantic` | None | Resident f16 vector matrix exact SIMD scan (`simsimd` kernel). Returns 503 if unmaterialized. |
| `GET` | `/search/fusion` | None | Reciprocal Rank Fusion (RRF) combining FTS5 lexical and SIMD semantic hits. |

### Trajectory & Research Interchange Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/trajectory` | None | Project a stored session into Quasar (`quasar.trajectory/v1`), Letta (`letta.trajectory/v1`), or Harbor ATIF (`quasar.trajectory.atif-export/v1`). |
| `GET` | `/research-export` | None | Stream chunked sharded corpus frames as NDJSON (`application/x-ndjson`) for reproducible research. |

### Maintenance & Diagnostics Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | None | Lightweight liveness probe reporting server home, SQLite path, and basic table counts. |
| `GET` | `/ready` | None | Search readiness probe reporting enabled search modes (`lexical`, `semantic`, `fusion`) and matrix status. |
| `GET` | `/status` | None | Deep operational diagnostic (SQLite stats, queue gauges by kind, embedding readiness, workers, vector matrix watermark). |
| `GET` | `/maintenance/embeddings/replay-cache` | None | Replay cached vectors from `embedding_cache` into `message_vectors` up to `limit`. |
| `GET` | `/maintenance/embeddings/materialize-sqlite` | None | Materialize missing vectors directly to SQLite using active embedding provider up to `limit`. |
| `GET` | `/maintenance/queue/prune-resolved-failures` | None | Prune dead-letter queue jobs whose errors have been resolved. |
| `GET` | `/` | None | Embedded, self-contained dashboard UI (zero external assets or egress). |

---

## Authentication & Headers

Protected routes (`POST /ingest/*`, `POST /session-enrichments`) require an ingest bearer token configured on the server via `QUASAR_INGEST_TOKEN`.

- **Headers Accepted:**
  - `x-quasar-ingest-token: <token>`
  - `Authorization: Bearer <token>`
- **Behavior:**
  - If `QUASAR_INGEST_TOKEN` is unset on the server: Protected endpoints return `503 ServiceUnavailable` ("QUASAR_INGEST_TOKEN must be configured before remote ingest is enabled").
  - If token is missing or incorrect: Protected endpoints return `401 Unauthorized`.
  - Read/search GET endpoints require no authentication.

---

## Request & Response Specifications

### Ingest Routes

#### `POST /ingest/fingerprint`

Probes whether a source file has changed since it was last ingested.

- **Request Body:**
  ```json
  {
    "probe": {
      "sessionId": "codex:01900000-0000-7000-8000-000000000001",
      "sourceFingerprint": "{\"size\":12345,\"mtimeMs\":1718000000000}",
      "normalizationVersion": 12
    }
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "ingest/fingerprint",
    "data": {
      "unchanged": true
    }
  }
  ```

#### `POST /ingest/session`

Ingests one normalized session envelope. Supports query parameter `?force=true` to force re-processing even if the fingerprint matches.

- **Request Body:**
  ```json
  {
    "session": {
      "protocolVersion": "quasar.normalized-session/v1",
      "project": {
        "projectKey": "quasar",
        "displayName": "Quasar",
        "rawPath": "/work/quasar"
      },
      "session": {
        "sessionId": "codex:01900000-0000-7000-8000-000000000001",
        "projectKey": "quasar",
        "provider": "codex",
        "agentName": "codex",
        "title": "Fix vector kernel",
        "startedAt": "2026-07-26T12:00:00.000Z",
        "updatedAt": "2026-07-26T12:05:00.000Z",
        "sourcePath": "/Users/alice/.codex/history.jsonl",
        "sourceFingerprint": "{\"size\":12345,\"mtimeMs\":1718000000000}",
        "host": "mac-mini.local",
        "identitySchemeVersion": 1,
        "normalizationVersion": 12,
        "model": "gpt-5.6-sol",
        "modelProvider": "openai",
        "assignmentRole": "builder",
        "parentSessionId": null,
        "messageCount": 2,
        "toolCallCount": 1
      },
      "messages": [
        {
          "sessionId": "codex:01900000-0000-7000-8000-000000000001",
          "eventId": "codex:01900000-0000-7000-8000-000000000001:event:0",
          "seq": 0,
          "role": "user",
          "text": "Inspect the matrix kernel.",
          "ts": "2026-07-26T12:00:00.000Z",
          "projectKey": "quasar",
          "contentHash": "a1b2c3d4e5f6...",
          "executionContextId": null,
          "model": "gpt-5.6-sol",
          "modelProvider": "openai",
          "reasoningEffort": null
        },
        {
          "sessionId": "codex:01900000-0000-7000-8000-000000000001",
          "eventId": "codex:01900000-0000-7000-8000-000000000001:event:1",
          "seq": 1,
          "role": "assistant",
          "text": "Checking simsimd bindings.",
          "ts": "2026-07-26T12:01:00.000Z",
          "projectKey": "quasar",
          "contentHash": "f6e5d4c3b2a1...",
          "executionContextId": null,
          "model": "gpt-5.6-sol",
          "modelProvider": "openai",
          "reasoningEffort": null
        }
      ],
      "toolCalls": [
        {
          "id": "call-1",
          "sessionId": "codex:01900000-0000-7000-8000-000000000001",
          "eventId": "codex:01900000-0000-7000-8000-000000000001:event:1",
          "seq": 1,
          "toolName": "exec_command",
          "status": "completed",
          "inputText": "{\"command\":\"uname -m\"}",
          "outputText": "arm64",
          "startedAt": "2026-07-26T12:01:01.000Z",
          "completedAt": "2026-07-26T12:01:02.000Z",
          "projectKey": "quasar",
          "provider": "codex",
          "executionContextId": null,
          "model": "gpt-5.6-sol",
          "modelProvider": "openai",
          "reasoningEffort": null
        }
      ],
      "events": [ /* SessionEvent[] */ ],
      "usageRecords": [ /* UsageRecord[] */ ],
      "sessionEdges": [ /* SessionEdge[] */ ],
      "artifacts": [ /* Artifact[] */ ],
      "executionContexts": [ /* ExecutionContextRecord[] */ ],
      "assignment": { "role": "builder" }
    }
  }
  ```
- **Response `200 OK` (or `200` with `skipped` / `500` with `failed`):**
  ```json
  {
    "ok": true,
    "route": "ingest/session",
    "data": {
      "outcome": {
        "sessionId": "codex:01900000-0000-7000-8000-000000000001",
        "status": "ok",
        "messagesWritten": 2,
        "toolCallsWritten": 1,
        "jobsEnqueued": 1,
        "searchDocuments": {
          "totalMessages": 2,
          "semanticSearchDocuments": 1
        },
        "delta": {
          "messagesDeleted": 0,
          "messagesUnchanged": 0,
          "toolCallsDeleted": 0,
          "toolCallsUnchanged": 0
        }
      }
    }
  }
  ```

#### `POST /ingest/run`

Records the lifecycle state of a CLI provider ingest run.

- **Request Body:**
  ```json
  {
    "run": {
      "runId": "run-2026-08-17-001",
      "provider": "codex",
      "status": "completed",
      "startedAt": "2026-08-17T20:00:00.000Z",
      "completedAt": "2026-08-17T20:01:30.000Z",
      "sessionsSeen": 150,
      "sessionsWritten": 12,
      "sessionsSkipped": 138,
      "sessionsFailed": 0
    }
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "ingest/run",
    "data": { "run": { /* IngestRunRow */ } }
  }
  ```

---

### Resource Routes

#### Common Pagination Model

Resource collection endpoints (`/sessions`, `/tool-calls`, `/search/*`) use uniform offset pagination:

```json
{
  "page": {
    "limit": 100,
    "offset": 0,
    "nextOffset": 100
  }
}
```

The maximum server page limit is `RESOURCE_PAGE_MAXIMUM = 200`. When `nextOffset` is `null`, there are no further rows.

#### `GET /projects`

- **Query Parameters:** `limit` (default 100), `offset` (default 0).
- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "projects",
    "data": {
      "rows": [
        {
          "projectKey": "quasar",
          "displayName": "Quasar",
          "rawPath": "/work/quasar"
        }
      ]
    }
  }
  ```

#### `GET /sessions`

- **Query Parameters:**
  - `projectKey` (string)
  - `provider` (comma-separated or single provider: `codex,claude`)
  - `sessionId` (string)
  - `agentName` (string)
  - `agentRole` or `assignmentRole` (string)
  - `model` (string)
  - `modelProvider` (string)
  - `limit` (1..200, default 100)
  - `offset` (non-negative int, default 0)
- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "sessions",
    "data": {
      "rows": [
        {
          "sessionId": "codex:01900000-0000-7000-8000-000000000001",
          "projectKey": "quasar",
          "provider": "codex",
          "agentName": "codex",
          "title": "Fix vector kernel",
          "startedAt": "2026-07-26T12:00:00.000Z",
          "updatedAt": "2026-07-26T12:05:00.000Z",
          "model": "gpt-5.6-sol",
          "modelProvider": "openai",
          "assignmentRole": "builder",
          "parentSessionId": null,
          "messageCount": 2,
          "toolCallCount": 1
        }
      ],
      "page": { "limit": 100, "offset": 0, "nextOffset": null }
    }
  }
  ```

#### `GET /session-detail`

Reads bounded rich sections of one stored session.

- **Query Parameters:**
  - `sessionId` (**required**, string)
  - `messageLimit`, `messageOffset` (default 100, max 1000)
  - `toolCallLimit`, `toolCallOffset` (default 100, max 1000)
  - `eventLimit`, `eventOffset` (default 100, max 1000)
  - `usageLimit`, `usageOffset` (default 100, max 1000)
  - `edgeLimit`, `edgeOffset` (default 100, max 1000)
  - `artifactLimit`, `artifactOffset` (default 100, max 1000)
  - `contextLimit`, `contextOffset` (default 100, max 1000)
- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "session-detail",
    "data": {
      "session": { /* SessionRow */ },
      "project": { /* ProjectRow */ },
      "messages": [ /* MessageRow[] */ ],
      "toolCalls": [ /* ToolCallRow[] */ ],
      "events": [ /* SessionEvent[] */ ],
      "usageRecords": [ /* UsageRecord[] */ ],
      "sessionEdges": [ /* SessionEdge[] */ ],
      "artifacts": [ /* Artifact[] */ ],
      "executionContexts": [ /* ExecutionContextRecord[] */ ],
      "assignment": { "role": "builder" }
    }
  }
  ```

#### `GET /messages`

Reads messages in deterministic `(sessionId, seq)` sequence order. Supports keyset cursor pagination across session boundaries and snapshot-isolated message scans.

- **Query Parameters:**
  - `sessionId`, `projectKey`, `provider`, `role` (`user` | `assistant` | `reasoning`)
  - `agentName`, `agentRole`, `model`, `modelProvider`
  - `messageAfter`, `messageBefore` (ISO timestamp strings)
  - `sessionStartedAfter`, `sessionStartedBefore` (ISO timestamp strings)
  - `rootsOnly` (`true` | `false` | `1` | `0`)
  - `lineageRootSessionId` (string)
  - `limit` (1..200, default 100)
  - `afterSessionId`, `afterSequence` (keyset pagination cursor, must be passed together with `snapshot`)
  - `snapshot` (opaque transaction snapshot token)
- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "messages",
    "data": {
      "rows": [
        {
          "sessionId": "codex:01900000-0000-7000-8000-000000000001",
          "eventId": "codex:01900000-0000-7000-8000-000000000001:event:0",
          "seq": 0,
          "role": "user",
          "text": "Inspect the matrix kernel.",
          "ts": "2026-07-26T12:00:00.000Z",
          "projectKey": "quasar",
          "contentHash": "a1b2c3d4e5f6...",
          "executionContextId": null,
          "model": "gpt-5.6-sol",
          "modelProvider": "openai",
          "reasoningEffort": null
        }
      ],
      "page": {
        "limit": 100,
        "after": { "sessionId": "codex:01900000-0000-7000-8000-000000000001", "sequence": 0 },
        "next": null
      }
    }
  }
  ```

#### `GET /tool-calls`

Lists body-free tool-call metadata summaries. Full payloads are never returned on this route.

- **Query Parameters:** `projectKey`, `provider`, `sessionId`, `toolName`, `agentName`, `agentRole`, `model`, `modelProvider`, `limit`, `offset`.
- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "tool-calls",
    "data": {
      "rows": [
        {
          "id": "call-1",
          "sessionId": "codex:01900000-0000-7000-8000-000000000001",
          "eventId": "codex:01900000-0000-7000-8000-000000000001:event:1",
          "seq": 1,
          "toolName": "exec_command",
          "status": "completed",
          "startedAt": "2026-07-26T12:01:01.000Z",
          "completedAt": "2026-07-26T12:01:02.000Z",
          "projectKey": "quasar",
          "provider": "codex",
          "inputBytes": 24,
          "outputBytes": 5
        }
      ],
      "page": { "limit": 100, "offset": 0, "nextOffset": null }
    }
  }
  ```

#### `GET /tool-call`

Reads one complete tool call with full `input` and `output` payloads.

- **Query Parameters:** `id` (**required**, string).
- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "tool-call",
    "data": {
      "row": {
        "id": "call-1",
        "sessionId": "codex:01900000-0000-7000-8000-000000000001",
        "eventId": "codex:01900000-0000-7000-8000-000000000001:event:1",
        "seq": 1,
        "toolName": "exec_command",
        "status": "completed",
        "inputText": "{\"command\":\"uname -m\"}",
        "outputText": "arm64",
        "startedAt": "2026-07-26T12:01:01.000Z",
        "completedAt": "2026-07-26T12:01:02.000Z",
        "projectKey": "quasar",
        "provider": "codex",
        "executionContextId": null,
        "model": "gpt-5.6-sol",
        "modelProvider": "openai",
        "reasoningEffort": null
      }
    }
  }
  ```

#### `GET /session-enrichments` and `POST /session-enrichments`

Manages namespaced derived analysis envelopes (`quasar.session-enrichment/v1`). Re-ingest never overwrites enrichments.

- **`GET /session-enrichments` Parameters:** `projectKey`, `sessionId`, `namespace`, `producer`, `inputHash`, `limit`, `cursor`.
- **`POST /session-enrichments` Body:**
  ```json
  {
    "protocolVersion": "quasar.session-enrichment/v1",
    "sessionId": "codex:01900000-0000-7000-8000-000000000001",
    "namespace": "audit.security",
    "schemaVersion": 1,
    "producer": "secret-scanner/v2",
    "inputHash": "9e107d9d372bb6826bd81d3542a419d6",
    "payload": { "findings": 0, "verified": true },
    "updatedAt": "2026-08-17T21:00:00.000Z"
  }
  ```

---

### Search Routes

#### `GET /search/lexical`, `GET /search/semantic`, `GET /search/fusion`

Runs message search across the corpus.

- **Query Parameters:**
  - `q` or `query` (**required**, string)
  - `projectKey` (string)
  - `provider` (comma-separated or single)
  - `sessionId` (string)
  - `role` (`user` | `assistant` | `reasoning`)
  - `agentName`, `agentRole`, `model`, `modelProvider`
  - `limit` (1..200, default 100)
  - `offset` (non-negative int, default 0)
- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "search/fusion",
    "data": {
      "matches": [
        {
          "key": "codex:01900000-0000-7000-8000-000000000001:0",
          "score": 0.03225806451612903,
          "row": {
            "sessionId": "codex:01900000-0000-7000-8000-000000000001",
            "messageId": "codex:01900000-0000-7000-8000-000000000001:event:0",
            "sequence": 0,
            "role": "user",
            "text": "Inspect the matrix kernel.",
            "textTruncated": false,
            "textBytes": 26,
            "timestamp": "2026-07-26T12:00:00.000Z",
            "projectKey": "quasar",
            "provider": "codex",
            "agentName": "codex",
            "agentRole": "builder",
            "model": "gpt-5.6-sol",
            "modelProvider": "openai"
          }
        }
      ],
      "page": { "limit": 100, "offset": 0, "nextOffset": null },
      "receipt": {
        "lexicalCount": 1,
        "semanticCount": 1,
        "fusedCount": 1,
        "durationMs": 14.2
      },
      "degraded": false
    }
  }
  ```
- **Text Truncation:** Result texts exceeding `SEARCH_TEXT_MAXIMUM_BYTES = 2000` are safely UTF-8 sliced. `textTruncated` is set to `true`, and `textBytes` carries the full stored byte length.

---

### Trajectory & Research Export Routes

#### `GET /trajectory`

Projects stored normalized session facts into agent-readable or benchmark interchange formats.

- **Query Parameters:**
  - `sessionId` (**required**, string)
  - `format` (`quasar` | `letta` | `atif`, default `quasar`)
  - `includeReasoning` (`true` | `false` | `1` | `0`, default `true`)
  - `includeToolResults` (`true` | `false` | `1` | `0`, default `true`)
  - `toolResultMaxBytes` (optional non-negative integer for UTF-8-safe truncation)
- **Format Options:**
  - `format=quasar` (`quasar.trajectory/v1`): Deterministic flat sequence of `meta`, `user`, `assistant`, `reasoning`, `tool_call`, and `tool_result` records, plus `losses` ledger.
  - `format=letta` (`letta.trajectory/v1`): Strict export conforming to Letta Trajectory v1 schema plus compatibility issue ledger (`mixed_assistant_split`, `tool_call_timestamps_coalesced`).
  - `format=atif` (`quasar.trajectory.atif-export/v1`): Strict export conforming to Harbor ATIF v1.7 (pinned to commit `7db020ba5a5ceee918351dd8fc374d4d60bad442`), automatically embedding recursive subagent descendants (`parent_session_id`) and fact-level compatibility reporting.
- **Error `409 Conflict` (`TrajectorySourceInvalid`):** Returned if stored rows cannot decode into `quasar.normalized-session/v1` (requires re-ingest).

#### `GET /research-export`

Streams chunked, snapshot-isolated corpus frames as NDJSON (`application/x-ndjson`).

- **Query Parameters:**
  - Message filters: `sessionId`, `projectKey`, `provider`, `role`, `agentName`, `agentRole`, `model`, `modelProvider`, `messageAfter`, `messageBefore`, `sessionStartedAfter`, `sessionStartedBefore`, `rootsOnly`, `lineageRootSessionId`.
  - Pagination: `limit`, `afterSessionId`, `afterSequence`, `snapshot`.
  - Trajectory projection options: `includeReasoning`, `includeToolResults`, `toolResultMaxBytes`.
- **Response Stream Frames:**
  1. `manifest` frame: `snapshot`, `filters`, `page`, `trajectoryScope`, `trajectoryProjection`.
  2. `message` frames: Individual matching `ResearchExportMessage`.
  3. `trajectory` frames: Embedded `QuasarTrajectory` for the first matching message of each session.
  4. `receipt` frame: Message count, trajectory count, total bytes, SHA-256 hash (`sha256:...`), next scan cursor.
  5. `error` frame: Emitted on unrecoverable stream error.

---

### Maintenance & Diagnostics Routes

#### `GET /health`

- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "health",
    "data": {
      "status": "ok",
      "home": "/data/quasar",
      "sqlite": "/data/quasar/quasar.sqlite",
      "stats": {
        "projects": 302,
        "sessions": 13399,
        "messages": 669190,
        "toolCalls": 722276
      }
    }
  }
  ```

#### `GET /ready`

In-memory cheap check. Never runs SQL or embedder probes.

- **Response `200 OK` (Semantic Ready):**
  ```json
  {
    "ok": true,
    "route": "ready",
    "data": {
      "modes": { "lexical": true, "semantic": true, "fusion": true },
      "matrix": {
        "model": "synthetic:hf:nomic-ai/nomic-embed-text-v1.5:768:search_document",
        "rows": 669190,
        "dimensions": 768,
        "kernel": "simsimd-ffi",
        "watermark": {
          "matrixRows": 669190,
          "sqliteRows": 669190,
          "checkedAt": "2026-08-17T21:00:00.000Z"
        }
      }
    }
  }
  ```
- **Response `200 OK` (Semantic Disabled / Unmaterialized):**
  ```json
  {
    "ok": true,
    "route": "ready",
    "data": {
      "modes": { "lexical": true, "semantic": false, "fusion": false },
      "reason": "semantic pending vector materialization"
    }
  }
  ```

#### `GET /status`

Exhaustive service inspection.

- **Response `200 OK`:**
  ```json
  {
    "ok": true,
    "route": "status",
    "data": {
      "sqlite": { "right": { "sessions": 13399, "messages": 669190, "toolCalls": 722276 } },
      "queue": {
        "pending": 0,
        "leased": 0,
        "failed": 0,
        "byKind": { "embed-message": { "pending": 0, "leased": 0, "failed": 0 } }
      },
      "embeddings": {
        "model": "hf:nomic-ai/nomic-embed-text-v1.5",
        "readiness": { "ok": true, "checkedAt": "2026-08-17T21:00:00.000Z" }
      },
      "ingest": { "activeRuns": 0 },
      "workers": { "embedMessage": { "active": true, "leasedJobs": 0 } },
      "vectorMatrix": {
        "enabled": true,
        "rows": 669190,
        "dimensions": 768,
        "kernel": "simsimd-ffi",
        "workerCount": 8,
        "watermark": { "matrixRows": 669190, "sqliteRows": 669190, "checkedAt": "2026-08-17T21:00:00.000Z" }
      },
      "metrics": { /* Prometheus / OpenTelemetry gauge snapshots */ }
    }
  }
  ```

---

## Locked Boundary Invariants

The server rejects invalid payloads at the HTTP boundary before writing to SQLite:

1. **Protocol Version:** Missing or mismatched `protocolVersion` yields `400 ProtocolVersionMismatch` with expected and received versions.
2. **Provider Allowlist (Exactly 13):**
   `codex`, `claude`, `opencode`, `grok`, `kimi`, `hermes`, `antigravity`, `omp`, `pi`, `prime`, `cursor`, `devin`, `amp`.
3. **Message Role Allowlist (Exactly 3):**
   `user`, `assistant`, `reasoning`.
4. **Self-Consistency Counts:**
   `messages.length === session.messageCount`, `toolCalls.length === session.toolCallCount`. Mismatches fail with `400 BadRequest`.
5. **Event Identity & Monotonic Order:**
   Event IDs are unique, and sequence `seq` is dense and contiguous (`0, 1, 2, ...`). Every message and tool call points at an existing event with matching sequence.
6. **Execution Context Integrity:**
   `executionContextId` on message or tool-call rows must resolve to an `ExecutionContextRecord` present in the same payload.
7. **Body Size Transport Ceiling:**
   `SERVER_MAX_REQUEST_BODY_SIZE_BYTES = Number.MAX_SAFE_INTEGER` prevents transport-layer truncation while preserving strict protocol validation.

---

## Error Response Matrix

All error responses adhere to `{ ok: false, route: string, error: { type: string, message: string, ... } }`:

| HTTP Status | Error Type | Condition | Action / Meaning |
| --- | --- | --- | --- |
| `400` | `BadRequest` | Malformed JSON, unknown query param, or validation constraint violation. | Fix client query or payload shape. |
| `400` | `ProtocolVersionMismatch` | `protocolVersion` does not match expected version. | Upgrade CLI or client package. |
| `401` | `Unauthorized` | Missing or invalid `x-quasar-ingest-token` or Bearer header. | Supply configured ingest token. |
| `404` | `NotFound` | Requested resource ID (`sessionId`, `toolCallId`, `runId`) does not exist. | Verify resource identity. |
| `409` | `TrajectorySourceInvalid` | Stored session failed normalized contract validation. | Re-ingest session from source using current CLI. |
| `409` | `QuerySnapshotExpiredError` | Message scan cursor transaction expired. | Restart message scan without cursor. |
| `409` | `QuerySnapshotBusyError` | SQLite WAL snapshot conflict during scan. | Retry the same message page. |
| `500` | `InternalError` | Unexpected internal server failure. | Check server logs. |
| `503` | `SemanticDisabled` | Semantic/fusion search invoked when vector matrix is unmaterialized. | Materialize vectors and restart server. |
| `503` | `EmbeddingUnavailable` | Query embedder failed or unavailable. | Inspect embedder status / warmup. |
| `503` | `ServiceUnavailable` | Remote ingest disabled because `QUASAR_INGEST_TOKEN` is unset on server. | Set `QUASAR_INGEST_TOKEN` in `platform/server/.env`. |
