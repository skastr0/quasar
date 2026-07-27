# Quasar Session Contract and Projection Plan

Date: 2026-07-26.
Status: **in implementation** — Slices 1–3 are delivered and executable.
ATIF export and isolated corpus replay remain.

## Objective

Make Quasar's session representation a versioned, executable source-fact
contract, then derive purpose-built read formats from it without mistaking a
lossy projection for the session itself.

The first implementation target is event-faithful storage and retrieval. An
agent-readable trajectory and an ATIF benchmark export follow only after that
foundation can prove that it preserves the facts both projections need.

## Decision

Quasar owns five distinct representation layers:

| Layer | Owner | Contract |
| --- | --- | --- |
| Provider-native history | Each harness | Untrusted source input; never a Quasar public contract |
| Normalized source facts | Quasar adapters | One versioned contract containing sessions, events, content blocks, tool calls, relationships, execution contexts, usage, artifacts, project identity, and provenance |
| Storage and search projections | Quasar server | Materialized rows optimized for bounded reads and search; every derived row points back to normalized source identity |
| Agent and interchange projections | Quasar protocol/CLI | Query rows, a token-efficient trajectory, and benchmark exports derived from normalized facts |
| Derived enrichment | External or Quasar assessors | Namespaced, versioned analysis that source re-ingest never overwrites |

No single flat transcript replaces this stack. The normalized source-fact
contract is the authority. Every other shape declares what it selects, merges,
truncates, or cannot represent.

## What the reference formats establish

### Letta Trajectory

Letta's Trajectory format is optimized for an agent to read another agent's
experience cheaply. It flattens a transcript into ordered meta, user, reasoning,
assistant/tool-call, and tool-result records, drops harness bookkeeping, and may
truncate tool results. Letta reports roughly a five-fold token reduction over
native Claude Code and Codex transcripts.

That makes it the right reference for a Quasar **agent trajectory projection**,
not the normalized truth contract. Its schema also requires assistant content to
be null when tool calls are present. Quasar cannot adopt that restriction
internally because a native turn can carry visible assistant text, reasoning, and
multiple tool calls simultaneously.

Sources:

- <https://www.letta.com/blog/trajectory/>
- <https://github.com/letta-ai/trajectory>
- <https://github.com/letta-ai/trajectory/blob/main/schema/trajectory-v1.schema.json>

### Harbor ATIF

Harbor's Agent Trajectory Interchange Format is optimized for full-fidelity
debugging, replay, evaluation, supervised fine-tuning, and reinforcement
learning. It preserves sequential steps, structured tool calls and observations,
per-step metrics, optional token-level data, and nested subagent trajectories.

That makes ATIF the right reference for a Quasar **benchmark/export
projection**. Quasar should emit a compatibility report for facts it cannot
supply rather than fabricate absent tool definitions, token IDs, log
probabilities, rewards, or metrics.

Sources:

- <https://www.harborframework.com/docs/agents/trajectory-format>
- <https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md>

### Quasar's durable advantage

Quasar already models facts neither reference is designed to own as a local
cross-harness system: machine-independent session identity, project resolution,
native and canonical event identity, source references, content blocks,
event/session relationships, assignment lineage, execution-context changes,
usage, and artifacts.

The opportunity is therefore not to choose between Letta and ATIF. It is to make
Quasar's richer normalized layer executable and trustworthy enough to produce
both.

## Defects repaired by Slices 1–3

The architecture is ahead of the implementation at five load-bearing seams.

| Gap | Repair | Executable receipt |
| --- | --- | --- |
| Derived messages lost source identity | Persist and serve canonical `eventId`; retain normalized event sequence | Mixed OpenCode HTTP contract resolves reads/search to exact source events |
| Event kind gated visible text | Derive conversational text from role and admitted content independently of event kind | Mixed assistant text survives beside reasoning and two tool calls |
| OpenCode event order was not monotonic | Assign one dense chronological sequence across main and co-occurring events | Adapter and persisted-read assertions lock `[0, 1, 2, 3]` |
| Model attribution was flattened | Persist per-event execution context/model on message and tool rows | Model-change fixture returns `model-alpha` then `model-beta` |
| The source contract was duplicated and undiscoverable | Publish strict `quasar.normalized-session/v1` in the protocol package and decode it at ingest and reconstructed-read boundaries | Protocol examples cover every stable provider; skew and broken references fail closed |
| No agent-readable session projection existed | Publish `quasar.trajectory/v1`, an HTTP/CLI read, and a strict Letta-compatible export | Mixed OpenCode trajectory preserves text, reasoning, two calls/results, truncation pointers, and search isolation |

Relevant implementation surfaces:

- `packages/cli/src/core/schemas.ts`
- `packages/cli/src/map.ts`
- `packages/cli/src/adapters/opencode.ts`
- `packages/cli/src/model.ts`
- `packages/server/src/model.ts`
- `packages/server/src/store.ts`
- `packages/protocol/src/index.ts`
- `docs/architecture/cli-server-http-contract.md`

The complete tool payload path is not a current gap: tool inputs and outputs now
retain their redacted source structure and remain outside search indexing by
default.

## Contract invariants

The canonical normalized contract must make these statements executable:

1. **Stable identity.** Every admitted event has a stable canonical ID, optional
   native ID, provider/session identity, and source reference.
2. **Total order.** Event sequence is deterministic, unique within a session,
   and monotonic in the order returned and stored. Co-occurring facts receive
   distinct adjacent positions.
3. **Orthogonal facts.** Role, event kind, visible content, reasoning, and tool
   activity are independent dimensions. The presence of a tool call never
   erases visible text.
4. **Explicit cardinality.** One event may own zero, one, or many tool calls;
   each tool result links to the call/event it answers.
5. **Event-faithful derivation.** Every message/search row carries its source
   event ID. A projection index may optimize storage, but it never becomes
   identity.
6. **Per-event context.** Model, model provider, reasoning effort, and other
   execution context resolve at the event/turn that observed them. Session-level
   "latest" fields are summaries only.
7. **Complete admitted text.** Every non-empty visible text fact selected by the
   message policy appears exactly once in the message projection. Reasoning
   appears exactly once when included. Tool payloads remain structurally
   retrievable and unindexed by default.
8. **Declared loss.** A projection that omits, merges, or truncates a fact emits
   enough metadata to disclose that transformation and retrieve the full source
   fact.
9. **Separate derivation.** Enrichment carries producer, schema version, input
   hash, and namespace; source replay never edits it.

## Delivery sequence

### Slice 1 — Prove and repair event-faithful reads

Add failing integration tests that drive provider fixture data through the
adapter, `mapSession`, server ingest, resource read, and search paths. The
minimum cases are:

- an OpenCode assistant turn containing reasoning, visible text, and a tool call;
- reasoning followed by a later visible turn, proving monotonic sequence;
- multiple tool calls owned by one event;
- a session whose model changes between turns;
- a search result resolving back to the exact normalized source event.

Then replace the broken seam in one migration:

- persist `event_id` on every message row and use it as public `messageId`;
- preserve normalized event order instead of assigning identity from a compacted
  projection index;
- derive visible messages from eligible role plus non-empty text, independent of
  event kind;
- make OpenCode assign one dense chronological event sequence;
- materialize per-message model/context attribution while retaining session
  "latest model" only for cheap session listing;
- bump the normalization version and replay unchanged current sources.

Acceptance:

- the five integration cases fail before the change and pass after it;
- every message row joins to exactly one stored normalized event;
- no stored normalized event has a duplicate or decreasing sequence;
- current-source provider fixtures and adapter goldens show no unintended text,
  tool, lineage, usage, or artifact loss;
- root typecheck and test suites pass;
- a live bounded re-ingest proves mixed OpenCode text is searchable and targeted
  reads return its source event.

### Slice 2 — Publish the normalized source contract

Move the repaired source-fact schemas into `@skastr0/quasar-protocol` under a
versioned protocol identifier. Both CLI and server consume the same Effect
Schema and generated TypeScript types while retaining their existing package
boundary: provider parsing remains CLI-only and persistence remains
server-only.

The public schema contains:

- session and project/machine identity;
- assignment;
- events and content blocks;
- tool calls and event/session relationships;
- execution contexts and usage records;
- artifacts and raw source references;
- explicit counts and normalization version.

The ingest boundary decodes this contract rather than maintaining hand-written
shape predicates. `schema show` and examples expose it beside query and
enrichment contracts. The HTTP contract document is updated in the same commit.

Acceptance:

- CLI and server contain no second structural definition of the normalized
  source contract;
- schema decode rejects broken references, invalid roles/kinds, duplicate IDs,
  duplicate sequences, and cross-session rows before persistence;
- the protocol package can emit JSON Schema and decode a representative fixture
  from every stable provider;
- CLI/server deployment skew fails closed with an explicit protocol-version
  error.

### Slice 3 — Add the agent-readable trajectory projection

Status: **delivered**.

Define `quasar.trajectory/v1` as a bounded projection over normalized source
facts. It should be easy for another agent to read without loading provider
bookkeeping.

Required properties:

- flat chronological records with stable record and source-event IDs;
- meta, user, assistant, reasoning, tool-call, and tool-result records;
- visible assistant text and tool calls may coexist without either being
  discarded;
- multiple tool calls per event and explicit result linkage;
- caller-selectable reasoning and tool-result inclusion;
- any truncation reports original bytes, returned bytes, content hash, and the
  targeted full-read pointer;
- optional Letta-compatible export performs any necessary record splitting at
  this projection boundary only.

Acceptance:

- projecting the mixed OpenCode fixture preserves visible text, reasoning, every
  tool call, and every result;
- projection is deterministic for the same normalized input;
- no tool payload enters lexical or semantic search as a side effect;
- full source facts remain retrievable from every truncated record.

Implemented surfaces:

- `packages/protocol/src/trajectory.ts`: strict Quasar and Letta schemas,
  deterministic projection, compatibility report, and examples;
- `GET /trajectory`: reconstructs and validates complete persisted source facts
  before projection; stale pre-contract rows return `TrajectorySourceInvalid`
  with a re-ingest action;
- `quasar trajectory --session <id>`: Quasar or Letta output, caller-selected
  reasoning/results, and caller-selected UTF-8-safe tool-result byte limit;
- end-to-end OpenCode proof: adapter → mapping → HTTP ingest → SQLite →
  trajectory/Letta reads, with tool payloads still absent from search.

### Slice 4 — Add ATIF export and compatibility validation

Implement a pure normalized-session-to-ATIF adapter against Harbor's current
schema and validator. Map Quasar event order, reasoning, tool calls/results,
usage, and subagent relationships where supported. Put additional
Quasar-specific provenance in ATIF extension fields only where the format
permits it.

Every export also returns a compatibility report:

- mapped facts;
- omitted-by-policy facts;
- source facts ATIF cannot represent;
- ATIF fields Quasar did not observe;
- validation result and schema version.

Acceptance:

- exports validate against the pinned ATIF schema;
- benchmark fixtures cover tools, reasoning, usage, and subagent trajectories;
- absent metrics or token-level data remain absent, never zero-filled or
  inferred;
- exporting and re-reading preserve all facts claimed by the compatibility
  report.

## Verification matrix

| Layer | Deterministic proof |
| --- | --- |
| Provider adapter | Fixture and golden tests; bounded live corpus sample |
| Normalized contract | Effect Schema decode plus referential-invariant tests |
| Storage projection | Ingest/read integration tests and source-event joins |
| Search projection | Exact mixed-turn regression queries |
| Agent trajectory | Snapshot plus source-pointer completeness checks |
| ATIF export | Pinned Harbor schema validator plus compatibility report |
| TypeScript changes | `bun run typecheck && bun run test`; additional static analyzers may be run as a separate requested gate |

## Explicit non-goals

- Replacing Quasar's normalized source facts with Letta Trajectory or ATIF.
- Storing provider-native records as the public contract.
- Embedding or search-indexing tool inputs/outputs by default.
- Combining source facts with AI-generated enrichment.
- Adding a second database, event store, compaction layer, or generic adapter
  framework.
- Designing around unmeasured oversized inputs; provider garbage remains a
  named boundary rejection.

## Immediate next move

Implement Slice 4 against a pinned Harbor ATIF schema and validator. After that,
run an isolated full-corpus replay into a disposable database, reconcile source
and persisted counts/provider diagnostics, and only then migrate the production
truth store.
