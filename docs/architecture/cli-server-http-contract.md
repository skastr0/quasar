# CLI ⇄ Server HTTP Contract

This is the binding wire contract between the Quasar **CLI** (the sole ingest
writer) and the Quasar **server** (storage and serving only). It is duplicated —
on purpose — across `packages/cli/src` and `packages/server/src`; there is no
shared ingest package. Drift is caught by executable tests, not prevented by a
shared module.

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
  (`isMappedSession` validation → `ingestMappedSession`).

The CLI never runs the server's SQLite store, search substrate, or server runtime
in-process (enforced by `packages/cli/test/package-boundary.test.ts`). The
server never imports CLI or provider-parser modules (enforced by
`packages/server/test/boundary.test.ts`).

## Endpoints

| Method | Path                  | Purpose                                                                 |
| ------ | --------------------- | ----------------------------------------------------------------------- |
| POST   | `/ingest/fingerprint` | Probe `(sessionId, sourceFingerprint, normalizationVersion)` freshness. |
| POST   | `/ingest/session`     | Write one normalized `MappedSession`.                                   |
| POST   | `/query`              | Execute the strict, projected, cursor-paginated query protocol.         |
| GET    | `/projects`           | List project identities.                                                |
| GET    | `/session-detail`     | Read bounded rich session sections, including raw normalized events.    |

Both ingest endpoints require a bearer token. The server fails **closed**:

- No `QUASAR_INGEST_TOKEN` configured → `503` (remote ingest disabled).
- Missing/invalid `x-quasar-ingest-token` (or `Authorization: Bearer …`) → `401`.
- Body not valid JSON, or shape not a normalized payload → `400`, **before** any
  store write. The CLI client surfaces a `4xx` as a thrown `RemoteIngestError`
  and never falls back to embedded/local persistence.

`/ingest/session` accepts `?force=true` to bypass the unchanged-fingerprint
skip. All read/serve/operator endpoints operate over server state only — there
is no provider-history command on the server. The former read routes
(`/sessions`, `/messages`, `/tool-calls`, `/tool-call`, and `/search/*`) were
deleted; `/query` is the one structured read contract for those row sets.

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

`MappedSession` (see `packages/{cli,server}/src/model.ts`):

```ts
interface MappedSession {
  project: { projectKey: string; displayName: string; rawPath?: string };
  session: SessionRow;       // includes messageCount, toolCallCount
  messages: MessageRow[];    // role ∈ { user, assistant, reasoning }
  toolCalls: ToolCallRow[];
}
```

### Locked boundary invariants

The server rejects anything outside these at the ingest boundary:

- **Provider enum — exactly eleven literals:** `codex`, `claude`, `opencode`,
  `grok`, `kimi`, `hermes`, `antigravity`, `omp`, `pi`, `cursor`, `devin`
  (`packages/server/src/provider.ts`).
- **Message-role allowlist — exactly three:** `user`, `assistant`, `reasoning`.
- **Self-consistency:** `messages.length === session.messageCount`,
  `toolCalls.length === session.toolCallCount`, and every message/tool-call row
  carries the session's `sessionId`/`projectKey` (tool calls also the
  `provider`). Mismatches are rejected with `400` and write zero rows.

The `SessionRow` interface is held byte-for-byte identical across the two
packages by `packages/cli/test/wire-contract.test.ts`. The provider enum and
role allowlist are locked by `packages/server/test/boundary.test.ts`.

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

## Query protocol

`POST /query` accepts `quasar.query/v1`, defined and JSON-Schema-exported by
`packages/protocol`. The discriminated query kinds are:

- `search`: lexical, semantic, or fusion message search;
- `sessions`: normalized session metadata;
- `messages`: normalized user, assistant, and reasoning rows for one session;
- `toolCalls`: structural tool-call rows.

Each request contains typed filters, an explicit `summary` or `detail`
projection with a field allowlist, and a page `{ limit, cursor? }`. Provider
filters accept all eleven provider literals. Session-backed filters include
project, provider, session, agent name/role, model, and model provider; tool
queries additionally accept tool-call id and tool name. Cursors are opaque and
bound to the query shape, so changing filters or projections requires starting
without the prior cursor.

Tool-call summary projection deliberately exposes metadata and byte counts but
not `input` or `output`. Those payloads require a detail projection, making
enumeration cheap while retaining lossless targeted retrieval.

The CLI exposes the same contract in two layers:

- ergonomic `search`, `sessions`, `messages`, `tool-calls`, and `tool-call`
  commands with common filters, `--fields`, `--detail`, `--cursor`, and
  `--limit`;
- `query <inline-json|@file|->`, plus local `schema` and `examples`
  discovery, for jq-style machine composition without a second wire format.

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
and reads normalized rows back through `/query`. Protocol schema tests lock
strict decode, projections, pagination, and enrichment composition. A malformed
ingest payload is asserted to yield a `4xx` through the CLI client with zero
rows persisted.
