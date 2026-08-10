# CLI ⇄ Server HTTP Contract

This is the binding wire contract between the Quasar **CLI** (the sole ingest
writer) and the Quasar **server** (storage and serving only). It is not
duplicated in either package. `@skastr0/quasar-protocol` owns the one versioned
Effect Schema and generated TypeScript type consumed by both packages.

## Ingestion is CLI-side only

The server **does not ingest.** It never scans, discovers, or parses provider
histories, and it holds no provider history-root configuration. All provider
discovery, parsing, normalization, fingerprinting, and mapping happen in the
CLI. The CLI POSTs already-normalized sessions to the server over HTTP; the
server validates the wire shape at its boundary and writes to SQLite, then
enqueues derived-index work.

- CLI ingest client: `packages/cli/src/ingest.ts`
  (`ingestRemote` → `postFingerprintProbe` / `postMappedSession`).
- Server HTTP boundary: `packages/server/src/server.ts`
  (`decodeMappedSessionSync` → `ingestMappedSession`).

The CLI never runs the server's SQLite store, search substrate, or server runtime
in-process (enforced by `packages/cli/test/package-boundary.test.ts`). The
server never imports CLI or provider-parser modules (enforced by
`packages/server/test/boundary.test.ts`).

## Endpoints

| Method | Path                  | Purpose                                                                 |
| ------ | --------------------- | ----------------------------------------------------------------------- |
| POST   | `/ingest/fingerprint` | Probe `(sessionId, sourceFingerprint, normalizationVersion)` freshness. |
| POST   | `/ingest/session`     | Write one normalized `MappedSession`.                                   |
| GET    | `/projects`           | List project identities.                                                |
| GET    | `/session-detail`     | Read bounded rich session sections, including raw normalized events.    |
| GET    | `/trajectory`         | Project a complete stored session into Quasar, Letta, or Harbor ATIF trajectory form. |
| GET    | `/sessions`           | List source-rich sessions with scoped filters and bounded pagination.   |
| GET    | `/messages`           | Read one session's messages in sequence order with bounded pagination.  |
| GET    | `/tool-calls`         | List body-free tool-call summaries with scoped filters.                 |
| GET    | `/tool-call`          | Read one complete tool call.                                            |
| GET    | `/search/*`           | Run lexical, semantic, or fusion search.                                |

Both ingest endpoints require a bearer token. The server fails **closed**:

- No `QUASAR_INGEST_TOKEN` configured → `503` (remote ingest disabled).
- Missing/invalid `x-quasar-ingest-token` (or `Authorization: Bearer …`) → `401`.
- Body not valid JSON, or shape not a normalized payload → `400`, **before** any
  store write. The CLI client surfaces a `4xx` as a thrown `RemoteIngestError`
  and never falls back to embedded/local persistence.

`/ingest/session` accepts `?force=true` to bypass the unchanged-fingerprint
skip. All read/serve/operator endpoints operate over server state only — there
is no provider-history command on the server. Resource GET endpoints are the
only agent-facing read surface. The server deliberately has no generic
`POST /query` route.

## Normalized payload shape

`POST /ingest/session` body:

```jsonc
{ "session": MappedSession }
```

`POST /ingest/fingerprint` body:

```jsonc
{
  "probe": {
    "sessionId": string,
    "sourceFingerprint": string,
    "normalizationVersion": number
  }
}
```

`MappedSession` (see
`packages/protocol/src/normalized-session.ts`):

```ts
interface MappedSession {
  protocolVersion: "quasar.normalized-session/v1";
  project: { projectKey: string; displayName: string; rawPath?: string };
  session: SessionRow;       // includes messageCount, toolCallCount
  messages: MessageRow[];    // event-faithful search/read projection
  toolCalls: ToolCallRow[];
  events: SessionEventRow[];
  usageRecords: UsageRecordRow[];
  sessionEdges: SessionEdgeRow[];
  artifacts: ArtifactRow[];
  executionContexts: ExecutionContextRow[];
  assignment?: AgentAssignment;
}
```

Every `MessageRow` carries the canonical normalized `eventId`, the source
event's `sequence`, and its resolved execution-context/model provenance. Every
`ToolCallRow` carries the event that owns it plus the same context fields.
`session.model` and `session.modelProvider` remain latest-value summaries for
cheap session listing; they are not used as per-message attribution.

### Locked boundary invariants

The server rejects anything outside these at the ingest boundary:

- **Protocol version:** missing or mismatched `protocolVersion` returns a typed
  `ProtocolVersionMismatch` `400` with expected and received versions.
- **Provider enum — exactly thirteen literals:** `codex`, `claude`, `opencode`,
  `grok`, `kimi`, `hermes`, `antigravity`, `omp`, `pi`, `prime`, `cursor`, `devin`, `amp`
  (`packages/server/src/provider.ts`).
- **Message-role allowlist — exactly three:** `user`, `assistant`, `reasoning`.
- **Self-consistency:** `messages.length === session.messageCount`,
  `toolCalls.length === session.toolCallCount`, and every message/tool-call row
  carries the session's `sessionId`/`projectKey` (tool calls also the
  `provider`). Mismatches are rejected with `400` and write zero rows.
- **Event identity and order:** event IDs are unique; event sequence is dense,
  unique, and equal to stored order; every message and tool call points at an
  existing event with the same sequence.
- **Event-faithful message projection:** at most one message row may point at an
  event; its role must be the event's normalized conversational role. Message
  identity is the source `eventId`, never a synthesized projection index.
- **Context references:** projected execution-context IDs must resolve to an
  execution-context record in the same payload.

The protocol package publishes strict JSON Schemas and executable examples for
both provider-normalized source sessions and the mapped ingest representation.
The source schema requires its normalization version plus exact event, tool-call,
content-block, relationship, usage, and artifact counts; mismatches fail decode.
`packages/cli/test/wire-contract.test.ts` prevents CLI/server redeclarations;
provider and role enums remain locked by server boundary tests.

## Re-ingest without rebuilds or duplicates

Source freshness is the pair `(sourceFingerprint, normalizationVersion)`, not
the source fingerprint alone. A normalization-version bump deliberately
replays unchanged source files through the current adapters once. The server's
transactional upserts compare normalized rows at their canonical keys, update
changed rows, delete rows no longer emitted by that session, and enqueue
derived-index work only for message changes. Replaying the same version and
fingerprint is then a no-op.

This is the recovery path for model, assignment, execution-context, event, or
tool-payload fields that an older normalizer dropped: bump the normalization
version and run normal ingest. Do not recreate SQLite and do not invent a
parallel repair database.

## Resource reads and local query composition

The public HTTP contract is resource-shaped. Collection responses carry
`data.rows` and `data.page`; search responses carry `data.matches` and
`data.page`. Every page is:

```ts
interface ResourcePage {
  limit: number;             // 1..200
  offset: number;            // non-negative
  nextOffset: number | null;
}
```

`/sessions`, `/messages`, and `/tool-calls` accept resource-specific filters as
query parameters. `/search/lexical`, `/search/semantic`, and `/search/fusion`
accept `q`, the same session-backed filters, and bounded pagination. Search
returns bounded excerpts with the stored byte length and a truncation marker;
full text comes from the targeted `/messages` read. `/tool-calls` never selects
or returns input/output bodies. `/tool-call?id=...` is the sole full-payload
tool-call read.

### Agent-readable trajectory

`GET /trajectory` requires `sessionId` and accepts:

- `format=quasar|letta|atif` (default `quasar`);
- `includeReasoning=true|false|1|0` (default `true`);
- `includeToolResults=true|false|1|0` (default `true`);
- optional non-negative `toolResultMaxBytes`.

The server reads every persisted normalized fact for the selected session,
reconstructs `MappedSession`, and decodes it against
`quasar.normalized-session/v1` before projection. It does not scan provider
history and does not mutate SQLite or search indexes. A pre-migration or corrupt
stored session fails closed with `409 TrajectorySourceInvalid` and an explicit
re-ingest action; the server never emits a plausible partial trajectory.

The default response is strict `quasar.trajectory/v1`: a deterministic flat
sequence of session/event metadata, user, assistant, reasoning, tool-call, and
tool-result records. Each record carries stable projection identity, source
event identity where applicable, and a full-read pointer. Visible assistant
text and multiple tool calls from the same native event remain separate,
coexisting facts.

`toolResultMaxBytes` is caller-selected rather than a hidden product cap.
Truncation is UTF-8 safe and reports original/returned bytes, SHA-256 content
hash, and a targeted `/tool-call` pointer. Excluded or unrepresentable facts
appear in the `losses` ledger.

`format=letta` returns a strict export matching Letta Trajectory v1 plus a
compatibility report. Quasar splits mixed assistant text and tool calls only at
this export boundary because Letta requires assistant content to be `null` when
`tool_calls` are present. Missing timestamps and Quasar-only provenance are
reported, never fabricated.

`format=atif` returns `quasar.trajectory.atif-export/v1`: a Harbor
ATIF-v1.7 trajectory plus a fact-level compatibility ledger. The schema is
pinned to Harbor commit `7db020ba5a5ceee918351dd8fc374d4d60bad442`.
The server loads every stored descendant selected by `parent_session_id` and
embeds the resulting subagent tree in one document. Quasar-only source
identity, relationships, execution contexts, artifacts, and non-core usage
remain under ATIF `extra` fields. Missing metrics are absent rather than
zero-filled or inferred.

`quasar.query/v1`, defined and JSON-Schema-exported by `packages/protocol`, is a
**local CLI composition input**, not an HTTP endpoint. Its discriminated kinds
are:

- `search`: lexical, semantic, or fusion message search;
- `sessions`: normalized session metadata;
- `messages`: normalized user, assistant, and reasoning rows for one session;
- `toolCalls`: structural tool-call rows.

Each request contains typed filters, an explicit `summary` or `detail`
projection with a field allowlist, and a bounded page. The CLI dispatches the
kind to the corresponding GET resource, applies projection locally, and emits
the typed `quasar.query/v1` response. Its opaque cursor is a shape-bound local
encoding of the resource offset; the server sees only `limit` and `offset`.
Provider filters accept all thirteen provider literals. Session-backed filters
include project, provider, session, agent name/role, model, and model provider;
tool queries additionally accept tool name. A targeted tool-call id dispatches
to `/tool-call`.

Message and search model filters operate on the model resolved for each source
event. Message and detailed search rows return the source event as
`messageId`, plus `executionContextId` and `reasoningEffort`; tool-call rows
return `eventId` and the same event-level provenance. Search fusion therefore
deduplicates lexical and semantic hits by source event rather than by a
projection-local sequence key.

Tool-call summary projection deliberately exposes metadata and byte counts but
not `input` or `output`. Those payloads require a detail projection, making
enumeration cheap while retaining lossless targeted retrieval.

The CLI exposes the same contract in two layers:

- ergonomic `search`, `sessions`, `messages`, `tool-calls`, `tool-call`, and
  `trajectory` commands with common filters, local field projection, and
  bounded pagination;
- `query <inline-json|@file|->`, plus local `schema` and `examples`
  discovery, for jq-style machine composition over those same resources
  without a second server execution engine.

Rich raw normalized events, usage snapshots, relationships, artifacts, and
execution contexts remain on bounded `/session-detail`; they are intentionally
not flattened into message-query roles.

## Composable session enrichment

`packages/protocol` also defines and exports the strict
`quasar.session-enrichment/v1` envelope:

```ts
interface SessionEnrichment {
  protocolVersion: "quasar.session-enrichment/v1";
  sessionId: string;
  namespace: string;
  schemaVersion: number;
  producer: string;
  inputHash: string;
  payload: unknown;
  updatedAt: string;
}
```

This is a separate, namespaced composition boundary for future per-thread AI
analysis. It is not source-owned normalized data, and source re-ingest must
never overwrite it. Persistence and analysis scheduling remain separate
product decisions; the unified protocol already prevents either from requiring
a new session format.

## Truth vs. derived state

SQLite is the truth store and durable queue. Search state (FTS5 lexical index,
`message_vectors`, the resident vector matrix) is **derived**, rebuildable
entirely from stored sessions: the FTS rebuild migration and
`rematerialize`/`replay-embedding-cache` paths reconstruct search with
no re-ingest. This is proven by `packages/server/test/rebuild.test.ts`.

## Executable contract

The end-to-end contract is locked by
`packages/cli/test/http-contract.test.ts`: it spawns the real server, drives the
real CLI HTTP client (`postMappedSession` / `postFingerprintProbe`) against it,
and reads normalized rows back through the first-class GET resources. Server
tests assert `POST /query` is not registered. Protocol schema tests lock strict
local query decode, projections, pagination, and enrichment composition. A
malformed ingest payload is asserted to yield a `4xx` through the CLI client
with zero rows persisted. The same suite drives a real fabricated OpenCode
SQLite fixture through adapter parsing, mapping, HTTP ingest, bounded
message/tool reads, and lexical search; the mixed assistant text, reasoning,
two tool calls, later turn, model change, and exact source-event IDs are all
asserted after persistence. The same fixture is read as Quasar and Letta
trajectories; visible text, reasoning, both calls/results, compatibility loss,
truncation pointers, and the continued absence of tool payloads from lexical
search are asserted.
