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

The CLI never runs the server's SQLite store, LanceDB search, or server runtime
in-process (enforced by `packages/cli/test/package-boundary.test.ts`). The
server never imports CLI or provider-parser modules (enforced by
`packages/server/test/boundary.test.ts`).

## Endpoints

| Method | Path                  | Purpose                                                     |
| ------ | --------------------- | ---------------------------------------------------------- |
| POST   | `/ingest/fingerprint` | Probe whether a `(sessionId, sourceFingerprint)` is known. |
| POST   | `/ingest/session`     | Write one normalized `MappedSession`.                      |

Both ingest endpoints require a bearer token. The server fails **closed**:

- No `QUASAR_INGEST_TOKEN` configured → `503` (remote ingest disabled).
- Missing/invalid `x-quasar-ingest-token` (or `Authorization: Bearer …`) → `401`.
- Body not valid JSON, or shape not a normalized payload → `400`, **before** any
  store write. The CLI client surfaces a `4xx` as a thrown `RemoteIngestError`
  and never falls back to embedded/local persistence.

`/ingest/session` accepts `?force=true` to bypass the unchanged-fingerprint
skip. All read/serve/operator endpoints (`/sessions`, `/messages`,
`/tool-calls`, `/search/*`, `/status`, `/maintenance/*`, …) operate over server
state only — there is no provider-history command on the server.

## Normalized payload shape

`POST /ingest/session` body:

```jsonc
{ "session": MappedSession }
```

`POST /ingest/fingerprint` body:

```jsonc
{ "probe": { "sessionId": string, "sourceFingerprint": string } }
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

- **Provider enum — exactly seven literals:** `codex`, `claude`, `opencode`,
  `grok`, `kimi`, `hermes`, `antigravity` (`packages/server/src/provider.ts`).
- **Message-role allowlist — exactly three:** `user`, `assistant`, `reasoning`.
- **Self-consistency:** `messages.length === session.messageCount`,
  `toolCalls.length === session.toolCallCount`, and every message/tool-call row
  carries the session's `sessionId`/`projectKey` (tool calls also the
  `provider`). Mismatches are rejected with `400` and write zero rows.

The `SessionRow` interface is held byte-for-byte identical across the two
packages by `packages/cli/test/wire-contract.test.ts`. The provider enum and
role allowlist are locked by `packages/server/test/boundary.test.ts`.

## Truth vs. derived state

SQLite is the truth store and durable queue. LanceDB (lexical/vector/fusion
search) is **derived** state, rebuildable entirely from stored sessions: wiping
the index and replaying `listSessions → indexSession` reconstructs search with
no re-ingest. This is proven by `packages/server/test/rebuild.test.ts`.

## Executable contract

The end-to-end contract is locked by
`packages/cli/test/http-contract.test.ts`: it spawns the real server, drives the
real CLI HTTP client (`postMappedSession` / `postFingerprintProbe`) against it,
and reads sessions, messages, tool calls, queue, and lexical search back over
HTTP. A malformed payload is asserted to yield a `4xx` through the CLI client
with zero rows persisted.
