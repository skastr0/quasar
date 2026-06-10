# Quasar Ingest Reset Report

Date: 2026-06-09
Repo: `/Users/guilhermecastro/Projects/quasar`
Branch: `main`

This report documents the current reset state of Quasar, what went wrong with
the deleted architecture, what was tried, what failed, what was removed, what is
still salvageable, and what the next architecture should look like.

This is a failure report, not a defense of the old design. The old ingest path
was architecturally wrong because it treated local agent history as a data-dump
problem instead of a session-intelligence product problem. That mistake caused
the system to ingest, transport, store, reconcile, and protect the wrong data.

## Executive Summary

The previous Quasar ingest architecture failed because it centered large
session-shaped payloads, import jobs, chunks, cleanup metadata, and server-side
ETL orchestration. That was the wrong unit of work and the wrong product
boundary.

Quasar is meant to be a session-intelligence system. The product should ingest
the user-agent exchange, assistant responses, tool calls, tool results, usage,
artifacts, and searchable derived text. It should not ingest provider UI caches,
diff arrays, snapshots, display state, raw native database state, or other
provider-internal garbage unless that data is explicitly needed for session
intelligence.

The reset removed the old ingest/import plane. The repository is now a partial
foundation:

- Provider adapters and normalization vocabulary remain useful.
- Convex search, read, RAG, embedding readiness, and dashboard surfaces remain
  useful.
- The writer between those halves is intentionally missing.
- The `ingest` CLI command is now only a `row_stream / not_ready` placeholder.

The replacement architecture should be:

- CLI-owned ingestion state using local SQLite and Effect.
- Provider adapters that stream small normalized rows.
- Convex mutations that receive bounded row envelopes and upsert rows/search
  documents.
- Convex actions used only for orchestration work such as embeddings,
  backpressure, retries, and drains.
- Exact source-file reconciliation from the CLI ledger, using row IDs and
  tombstones, not generations and not cleanup metadata.

## Current Repository State

After the reset, the active diff is intentionally destructive:

- `48 files changed`
- `291 insertions`
- `17,039 deletions`

Large deleted areas include:

- `apps/control/convex/quasarIngest*`
- `packages/core/src/ingest.ts`
- `packages/core/src/ingest-identity.ts`
- `packages/core/src/session-intelligence.ts`
- `packages/cli/src/commands/ingest-ledger.ts`
- old ingest/import tests
- old bulk-ingest architecture docs
- local Convex backup script
- Convex migrations component dependency

Current scans show no remaining source references for the deleted concepts:

- `quasarIngest`
- `ingest-ledger`
- `session-intelligence`
- `IngestBatch`
- `IngestManifest`
- `importJob`
- `importChunk`
- `importRun`
- `cleanup metadata`
- `ingest generation`
- `partial session`
- backup/restore helpers for local Convex state

The current active ingest command is deliberately inert:

```ts
{
  mode: "row_stream",
  status: "not_ready"
}
```

The public HTTP capabilities now report that row streaming is not implemented:

```ts
ingestion: {
  rowStream: false,
  nativeHistoryWrites: false,
}
```

## Local State Reset

The old local/runtime state was deleted. This included:

- `~/.quasar-control`
- `~/.config/quasar`
- `apps/control/.convex`
- `apps/control/.env.local`
- `apps/control/.next`
- `apps/control/logs`
- `.quasar-runs`
- `~/.config/pulsar/repos/quasar-66d5433bb62b`

Two data points matter:

- `~/.quasar-control` had grown to roughly `42G` before deletion.
- Pulsar's Quasar observer cache was `492M` before deletion.

Those numbers are evidence that the old process was not merely moving a modest
amount of text. It was preserving and amplifying the wrong shapes of data.

Current local scans found no remaining Quasar/Convex/ingest state under:

- `~/.config`
- `~/.quasar-control`
- `~/.convex`

Current process and launchd scans found no Quasar writer, old restore process,
or Quasar launchd job.

## Validation After Reset

The reset currently passes:

- `bun run typecheck` in `packages/core`
- `bun run typecheck` in `packages/cli`
- `bun run typecheck` in `apps/control`
- `bun run test` in `packages/core`
- `bun run test` in `apps/control`
- `git diff --check`

`apps/control` currently has no test files. Its test script uses
`--passWithNoTests` because the old tests primarily protected the deleted
architecture.

## What Is Salvageable

### Provider Adapters

The adapter code under `packages/core/src/adapters/*` remains useful because it
contains provider-specific knowledge for:

- Codex
- Claude
- OpenCode
- Grok
- Amp
- Pi
- Kimi
- Droid
- Hermes
- Antigravity
- Cursor

However, the adapter interface is not yet the final shape. The old adapter path
can still materialize sessions in memory. That is acceptable only for bounded
discovery and tests. The production ingest path must stream rows.

### Domain Vocabulary

`packages/core/src/schemas.ts` still contains useful product vocabulary:

- provider
- project identity
- machine identity
- source root
- normalized session
- session event
- content block
- tool call
- usage record
- artifact
- session edge
- search request

The warning is that `NormalizedSession` must not become the transport unit
again. It can remain as an in-memory/read-side composition type, but ingest must
write smaller rows.

### Text Pruning and Redaction

The pruning/redaction work remains useful. The code now explicitly strips or
avoids non-indexable provider payloads such as:

- `summary.diffs`
- `summary.patches`
- `summary.snapshots`
- `workspace.diff`
- `workspace.patch`
- `workspace.snapshot`
- provider cache/state/UI fields
- encrypted/ciphertext values
- display-only state

This is aligned with the product. It should be treated as a mandatory safety
line for the next ingest system.

### Convex Search and Read Side

The Convex app still has a useful search/read substrate:

- `sessions`
- `sessionEvents`
- `contentBlocks`
- `toolCalls`
- `usageRecords`
- `artifacts`
- `projectIdentities`
- `projectAliases`
- `searchDocuments`
- `embeddingOutbox`
- `embeddingReadiness`
- `embeddingCache`
- text search
- semantic search
- fusion search
- session read APIs
- tool-call read APIs
- project aliasing

This side should stay, but only if the writer is redesigned around small rows.

### Dashboard

The dashboard remains useful as a thin inspection/search surface. It is not the
core product yet, but it can exercise:

- API connection settings
- project browsing
- session browsing
- search modes
- session reads
- project aliasing

It depends on the server tables being populated by the new ingest system.

## What Is Not Salvageable

The following concepts were mistakes and should not be restored:

- import jobs
- import chunks
- bulk ingest lifecycle
- job scheduling for session import
- batch session upload
- whole-session transport as the primary ingest unit
- generation-based cleanup
- cleanup metadata
- expected ID lists for old-row reconciliation
- old ingest ledger shape
- local Convex backup/restore affordances
- tests whose purpose was to preserve old import behavior
- migration-from-old-deployment thinking

They were deleted because they protected a bad shape of data.

## What Went Wrong

### 1. The Architecture Optimized For Data Warehousing, Not Session Intelligence

The central mistake was treating agent histories as raw databases to warehouse.
That encouraged broad ingestion of provider-native structures instead of
selective extraction of session-intelligence rows.

The product need is narrow:

- what the user said
- what the assistant said
- what tool was called
- what tool returned
- what files/artifacts matter
- what project/session/machine/provider context applies
- what text is searchable
- what semantic chunks are useful

The old path treated too much provider metadata as potentially important. That
was backwards. Provider metadata should be discarded unless it proves direct
product value.

### 2. The Unit Of Work Was Wrong

The old architecture treated a session, a chunk, or a batch as the unit of
ingest. That made large payloads normal.

The correct unit is a normalized row:

- one session row
- one event row
- one content block row
- one tool call row
- one tool result row
- one usage row
- one artifact row
- one search document row
- one tombstone row

A full session can be reconstructed from rows. It should not be the atomic
write unit.

### 3. The CLI Had No Durable Local Brain

The CLI attempted to read and send large sets of data without a proper local
state model. That made it fragile under:

- memory pressure
- interrupted runs
- large source histories
- retries
- partial success
- source-file changes
- duplicate detection
- delete reconciliation

The CLI needs a local SQLite ledger. Without it, it cannot reliably ingest a
large local corpus.

### 4. Convex Was Used As An ETL Engine

Convex is good at small, fast, reactive mutations and scheduled/action
orchestration. It is not a good place to run giant import loops over large blobs.

The old architecture pushed too much ETL responsibility into Convex:

- import job state
- chunk ingestion
- job scheduling
- cleanup lists
- server-side processing loops
- reconciliation of old session-shaped payloads

That put the hardest and largest work in the wrong place.

### 5. Wire Amplification Was Not Controlled

The source corpus may be "text", but that does not mean it stays small over the
wire or in storage.

Amplification came from several layers:

- provider-native JSON containing display/cache/state/diff fields
- nested arrays and repeated metadata
- full session objects containing repeated session/project/machine fields
- batch envelopes
- chunk envelopes
- import job metadata
- cleanup metadata
- expected ID lists
- duplicated raw text and derived search text
- repeated transmission on retry
- storage of both source-like structures and normalized rows

The result was that the system behaved as if it had far more than the useful
session text. This is how a local text corpus can become a multi-GB runtime
problem.

### 6. OpenCode Metadata Was Misclassified As Session Data

The `summary.diffs` problem is the clearest example.

Those fields existed in provider data, but they were not necessarily useful
session intelligence. Treating them as addressable session content was a
product failure. They should be pruned by default.

The next architecture must start from product semantics, not from provider
object shape.

### 7. Cleanup Metadata Recreated The Same Pressure In Another Place

The architecture tried to make whole-session import safer by adding cleanup and
reconciliation metadata. That was the wrong fix.

Instead of deleting the bad unit of work, it added more data around the bad unit
of work:

- cleanup lists
- expected IDs
- old/new reconciliation state
- import run/job bookkeeping

That recreated payload pressure in another form.

### 8. Backward Compatibility Thinking Was Harmful

The existing deployment and data were wrong. Trying to preserve continuity with
them meant keeping the mistake alive.

The correct decision was to delete the deployment state and source concepts
that existed only to protect the wrong data. That is why the reset removed old
import modules, backup/restore affordances, migration component wiring, and
tests for the deleted behavior.

### 9. Tests Protected The Wrong System

The deleted tests were not all valueless, but many of them encoded the old
import architecture. Keeping them would have created pressure to preserve bad
concepts.

Useful future tests should protect:

- bounded memory behavior
- row streaming
- pruning of non-product payloads
- idempotent row upserts
- exact tombstone reconciliation
- search document generation
- restart/retry behavior from the local SQLite ledger

They should not protect old import jobs or batch/chunk semantics.

### 10. The Full Ingest Run Was Never Successfully Completed

The goal was to ingest all sessions from Codex, Hermes, OpenCode, and
Claude-code. That did not succeed.

The failure was not merely that the data set was large. The deeper failure was
that the ingest path had the wrong shape:

- it carried unnecessary payloads
- it materialized too much in memory
- it had no durable local progress model
- it relied on server-side import machinery
- it attempted to reconcile bad writes instead of avoiding bad writes

## What Was Tried

The failed path included:

- building robust scale ingest around session batches
- adding import jobs and job chunks
- adding import run/job read APIs
- adding cleanup/reconciliation metadata
- adding an ingest ledger command
- attempting full corpus ingest
- inspecting memory failures and payload size
- identifying OpenCode `summary.diffs` and related provider metadata as payload
  blow-up sources
- removing provider garbage from projection rules
- ultimately deleting the old architecture instead of patching it

The useful discovery was not a working ingest path. The useful discovery was
the boundary:

Quasar must ingest normalized session-intelligence rows, not native provider
records and not full session blobs.

## Current Failure Boundaries

The reset is clean, but the system is not yet useful for new ingest.

Current limitations:

- `quasar ingest` is a placeholder.
- The server reports `rowStream: false`.
- There is no CLI SQLite ledger yet.
- There is no row-write HTTP endpoint yet.
- There is no Convex mutation set for row upsert/tombstone semantics.
- Some adapter APIs can still materialize arrays and must not be used as the
  production large-corpus path.
- The dashboard/search side will be empty until the new writer exists.

## Required Replacement Architecture

### Principle 1: CLI Owns Local Progress

The CLI should maintain a local SQLite database. Suggested tables:

- `source_roots`
- `source_files`
- `source_file_scans`
- `normalized_rows`
- `send_queue`
- `server_acks`
- `tombstones`
- `run_attempts`
- `backpressure_state`

The CLI must know:

- which source files exist
- which files changed
- which rows each file produced last time
- which rows were sent
- which rows were acknowledged
- which rows disappeared and need tombstones
- where to resume after interruption

### Principle 2: Adapters Stream Rows

Adapters should emit an async stream:

```ts
type IngestRow =
  | { type: "source_root"; row: SourceRootRow }
  | { type: "session"; row: SessionRow }
  | { type: "event"; row: SessionEventRow }
  | { type: "content_block"; row: ContentBlockRow }
  | { type: "tool_call"; row: ToolCallRow }
  | { type: "usage"; row: UsageRow }
  | { type: "artifact"; row: ArtifactRow }
  | { type: "search_document"; row: SearchDocumentRow }
  | { type: "tombstone"; row: TombstoneRow }
  | { type: "diagnostic"; row: AdapterDiagnosticRow };
```

The stream should be bounded. No adapter should need to load the entire corpus
or all sessions into memory.

### Principle 3: Session Is A Read Model, Not A Write Blob

A session should be reconstructed from:

- `sessions`
- `sessionEvents`
- `contentBlocks`
- `toolCalls`
- `usageRecords`
- `artifacts`
- `sessionEdges`

The write path should not send one large session object. A large session is
only large because it has many rows.

### Principle 4: Convex Mutations Stay Small

The server should accept bounded row envelopes. A transport batch is acceptable
only as a network optimization, not as the logical unit.

Example constraints:

- hard request body cap
- max rows per request
- max bytes per row
- max text bytes per row
- deterministic row IDs
- idempotency keys
- explicit rejected-row diagnostics

Convex mutations should:

- validate rows
- upsert rows by deterministic IDs
- write/update the corresponding search document
- enqueue embedding work if needed
- return acknowledgements and backpressure hints

They should not run long ETL loops.

### Principle 5: Actions Orchestrate, They Do Not Import The Corpus

Convex actions are appropriate for:

- embedding drain
- retry orchestration
- backpressure decisions
- health/readiness checks
- async enrichment

They should not own the main ingest scan of local files. The local corpus lives
on the user's machine; the CLI must drive it.

### Principle 6: Reconciliation Uses Exact Tombstones

No generations.

When a source file changes, the CLI should compare:

- row IDs produced by the previous scan of that source file
- row IDs produced by the current scan of that source file

Rows that disappeared produce tombstones. Rows that remain are upserted or
acknowledged as unchanged. This is exact source-file reconciliation.

### Principle 7: Search Is Generated At Write Time

Every row that matters for search should produce or update a `searchDocuments`
row immediately.

Search documents should contain:

- compact searchable text
- optional embedding text
- family/source ID
- project/machine/provider/agent filters
- role/kind/tool filters where applicable
- source references for inspection

This keeps search central to ingest instead of an afterthought.

### Principle 8: Raw Provider Data Is Not A Product Default

Raw provider data should not be stored by default.

If future inspection requires raw snippets, they should be:

- bounded
- redacted
- explicitly typed
- tied to a product use case
- excluded from search unless intentionally projected

The default stance should be: if it is not useful for session intelligence, it
does not enter Quasar.

## Concrete Next Build Plan

### Phase 1: Define The Row Contract

Create a small row schema package shared by CLI and Convex:

- row types
- row IDs
- source references
- size limits
- tombstones
- acknowledgements
- backpressure response

Do this before touching ingestion implementation.

### Phase 2: Build The SQLite Ledger

Implement the local ledger with Effect services:

- open database
- scan source files
- detect changed files
- record emitted rows
- enqueue sends
- record acknowledgements
- retry failed sends
- emit tombstones

This is the real ingest engine.

### Phase 3: Convert Adapters To Streaming

Provider adapters should expose streaming row readers. Existing adapter logic
can be mined, but the production path must not return a corpus-sized array.

Start with one provider, probably Codex or OpenCode, and prove:

- bounded memory
- no provider garbage
- deterministic row IDs
- correct session reconstruction
- search docs are generated

### Phase 4: Add Convex Row Endpoint

Add one HTTP endpoint for bounded row submission.

The endpoint should:

- reject oversized bodies
- reject oversized rows
- upsert rows idempotently
- apply tombstones
- create/update search docs
- return ack IDs
- return backpressure hints

No import jobs. No chunk jobs. No generations.

### Phase 5: Full Corpus Dry Run

Run the CLI in dry-run mode over all providers:

- Codex
- Hermes
- OpenCode
- Claude-code

Capture:

- files scanned
- rows emitted
- rows by type
- bytes by type
- pruned bytes estimate
- max row size
- p95 row size
- memory high-water mark
- elapsed time

Only after this should server writes be enabled.

### Phase 6: Full Corpus Write

Enable writes with conservative backpressure:

- small envelopes
- bounded concurrency
- server-controlled slowdown
- resumable ledger
- progress output

Success means the process can be interrupted and resumed without starting over
or duplicating rows.

## Acceptance Criteria For The New Ingest System

The new system is not acceptable until all of these are true:

- Full corpus scan does not hold all sessions in memory.
- Full corpus ingest can be interrupted and resumed.
- The CLI can report exactly what has been scanned, normalized, sent,
  acknowledged, retried, and tombstoned.
- Convex never receives giant session blobs.
- Convex mutations stay bounded and fast.
- Search documents are created at ingest time.
- Provider UI/cache/diff/snapshot garbage is pruned by default.
- A large session is represented as many small rows.
- Session inspection reconstructs from rows.
- There are tests proving the deleted architecture terms do not return as
  implementation concepts.

The last point does not mean keeping old code or compatibility tests. It means
the new code should have its own positive invariants: row streaming, bounded
payloads, local ledger state, and exact tombstones.

## Final Architecture Call

Convex is still a good fit for the search/read side:

- reactive tables
- search index
- RAG integration
- server-side embedding orchestration
- HTTP API for CLI/dashboard
- query/read APIs for sessions and tools

Convex is not the right place to perform bulk local corpus ETL.

The CLI plus local SQLite ledger is the right place to own:

- local file scanning
- provider parsing
- source-file reconciliation
- retry state
- progress state
- backpressure response

That means the final architecture is not "Convex only" and not "SQLite only".
It is a split architecture:

- SQLite/Effect in the CLI for ingest control.
- Convex for normalized searchable product state.
- Convex actions for bounded orchestration.
- Search documents as the main product projection.

This is not a best-of-a-poor-fit compromise. It is the architecture implied by
the physical location of the data, the product's search needs, and Convex's
execution model.
