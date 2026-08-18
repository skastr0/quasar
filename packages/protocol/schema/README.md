# Quasar Protocol Schemas & Contracts

This directory contains pinned external schemas, validation artifacts, and specification documentation for the Quasar session protocol, trajectory projections, and research export formats.

---

## Table of Contents

- [Protocol Architecture Overview](#protocol-architecture-overview)
- [Normalized Session Schemas](#normalized-session-schemas)
  - [1. NormalizedSession (`quasar.normalized-session/v1`)](#1-normalizedsession-quasarnormalized-sessionv1)
  - [2. MappedSession (`quasar.normalized-session-ingest/v1`)](#2-mappedsession-quasarnormalized-session-ingestv1)
  - [Structural & Relational Invariants](#structural--relational-invariants)
- [Harbor ATIF v1.7 Trajectory Schema](#harbor-atif-v17-trajectory-schema)
  - [Harbor Upstream Pinned Artifacts](#harbor-upstream-pinned-artifacts)
  - [Schema Invariants & Semantic Rules](#schema-invariants--semantic-rules)
  - [ATIF Export Envelope (`quasar.trajectory.atif-export/v1`)](#atif-export-envelope-quasartrajectoryatif-exportv1)
- [Letta Trajectory Export Schema (`quasar.trajectory.letta-export/v1`)](#letta-trajectory-export-schema-quasartrajectoryletta-exportv1)
  - [Role Mappings & Invariants](#role-mappings--invariants)
  - [Compatibility Issue Classification](#compatibility-issue-classification)
- [Quasar Agent Trajectory Schema (`quasar.trajectory/v1`)](#quasar-agent-trajectory-schema-quasartrajectoryv1)
  - [Record Types & Source Links](#record-types--source-links)
  - [Loss Reporting & Full-Read Pointers](#loss-reporting--full-read-pointers)
- [Research Export Frame Schema (`quasar.research-export/v1`)](#research-export-frame-schema-quasarresearch-exportv1)
  - [NDJSON Frame Protocol](#ndjson-frame-protocol)
  - [Deterministic Ordering & Checksum Receipts](#deterministic-ordering--checksum-receipts)
- [Query & Response Schemas](#query--response-schemas)
- [Session Enrichment Schema (`quasar.session-enrichment/v1`)](#session-enrichment-schema-quasarsession-enrichmentv1)

---

## Protocol Architecture Overview

The Quasar protocol is built using [Effect Schema](https://effect.website/) to enforce strict, fail-closed boundaries for data ingestion, search, trajectory projection, and inter-agent communication. All protocol contracts reject excess properties, mandate strict type bounds, and perform deep invariant verification.

The contracts are exposed through the `@skastr0/quasar-protocol` package and introspectable locally via `quasar schema <name>` and `quasar examples <name>`.

---

## Normalized Session Schemas

### 1. NormalizedSession (`quasar.normalized-session/v1`)

The canonical, provider-neutral representation of an ingested agent session. Captures complete conversational facts, multi-agent hierarchies, tool execution details, and resource utilization.

- **Current Normalization Version**: `12` (`NORMALIZATION_VERSION`)
- **Protocol Identifier**: `quasar.normalized-session/v1`

#### Core Entities

- **`NormalizedSession`**: Root document containing session metadata, project resolution, and collections of events, tool calls, edges, execution contexts, usage records, and artifacts.
- **`ProjectResolution`**: Deterministic resolution of project identity, workspace paths, and git remote origin with confidence metrics (`explicit`, `high`, `medium`, `low`).
- **`SessionEvent`**: Discrete atomic event in the transcript (`sequence`, `role`, `kind`, `contentBlocks`, `rawReference`). Roles include `user`, `assistant`, `developer`, `system`, `tool`, `thinking`, and `unknown`.
- **`ContentBlock`**: Executable discriminated union of content parts:
  - `text`: Plain text payload
  - `markdown`: Formatted markdown text
  - `thinking`: Reasoning / chain-of-thought prose
  - `image`: Image file path or URI with media type
  - `file`: Referenced file attachment
  - `json`: Structured JSON object
- **`ToolCall`**: Structural record of a tool invocation (`toolName`, `input`, `output`, `status`, `startedAt`, `completedAt`).
- **`SessionEdge`**: Relational directed graph edge between events or sessions (`next`, `parent`, `tool_result_for`, `forked_from`, `subagent_of`, `compacted_into`, `artifact_of`).
- **`ExecutionContextRecord`**: Model assignment, reasoning effort parameters, permission profiles, and collaboration mode for a session or turn.
- **`UsageRecord`**: Token counts (`inputTokens`, `outputTokens`, `reasoningTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`), monetary cost, and currency.
- **`Artifact`**: External file modifications, patches, generated code, or checkpoints associated with a session turn.
- **`AgentAssignment`**: Multi-agent metadata (`nickname`, `role`, `path`, `depth`).
- **`MachineIdentity`**: Hardware and host metadata (`machineId`, `hostname`, `tailscaleName`, `platform`).
- **`RawReference`**: Origin tracing pointer to native source file, line number, table, or row ID.

### 2. MappedSession (`quasar.normalized-session-ingest/v1`)

The wire format emitted by the CLI adapter layer and consumed by the server ingestion endpoint. Flattens normalized sessions into typed tabular rows matching the SQLite schema:

- `ProjectRow`: `projectKey`, `displayName`, `rawPath`
- `SessionRow`: `sessionId`, `projectKey`, `provider`, `agentName`, `title`, `startedAt`, `updatedAt`, `sourcePath`, `sourceFingerprint`, `model`, `modelProvider`, `messageCount`, `toolCallCount`
- `MessageRow`: `sessionId`, `eventId`, `seq`, `role` (`user` | `assistant` | `reasoning`), `text`, `ts`, `contentHash` (FNV-1a wide hash)
- `ToolCallRow`: `id`, `sessionId`, `eventId`, `seq`, `toolName`, `status`, `inputText`, `outputText`, `startedAt`, `completedAt`

### Structural & Relational Invariants

Both `NormalizedSession` and `MappedSession` enforce strict mathematical and relational invariants:

1. **Dense Zero-Based Indexing**: `event.sequence` must be strictly contiguous from `0` to `eventCount - 1`.
2. **Fact Ownership**: Every event, tool call, edge, usage record, and artifact must carry matching `sessionId`, `provider`, `agentName`, and `projectIdentityKey`.
3. **Reference Integrity**: All foreign key references (`toolCallId`, `parentEventId`, `fromEventId`, `toEventId`, `eventId`) must resolve to valid entities within the session.
4. **Content Block Integrity**: Content block sequences within an event must be dense from `0` to `contentBlockCount - 1`.
5. **Exact Count Reconciliation**: Document count headers (`eventCount`, `toolCallCount`, `contentBlockCount`, `sessionEdgeCount`, `usageRecordCount`, `artifactCount`) must exactly equal the cardinality of their respective arrays.
6. **Unique Identifiers**: No duplicate entity IDs are permitted across any collection.

---

## Harbor ATIF v1.7 Trajectory Schema

### Harbor Upstream Pinned Artifacts

Quasar pins the official [Harbor Framework](https://github.com/harbor-framework/harbor) Agent Trajectory Interchange Format (ATIF) v1.7.

- **Pinned Commit**: `7db020ba5a5ceee918351dd8fc374d4d60bad442`
- **Schema ID**: `https://github.com/harbor-framework/harbor/tree/7db020ba5a5ceee918351dd8fc374d4d60bad442/src/harbor/models/trajectories#ATIF-v1.7`
- **Model Definition**: `src/harbor/models/trajectories/trajectory.py`
- **Semantic Validator**: `src/harbor/utils/trajectory_validator.py`
- **Generated JSON Schema SHA-256**: `dcef1989e05cac504ecf0972f49b15956cb4000e2645292a5a12cad5d58c5338`
- **License**: Apache-2.0 (see `harbor-atif-v1.7.LICENSE`)

#### Schema Generation Recipe

Generated using Pydantic validation-mode JSON Schema:

```bash
PYTHONPATH=<harbor-checkout>/src uv run --no-project \
  --with 'pydantic==2.12.5' python -c \
  'import json; from harbor.models.trajectories import Trajectory; print(json.dumps(Trajectory.model_json_schema(mode="validation"), indent=2, sort_keys=True))'
```

### Schema Invariants & Semantic Rules

The ATIF schema in `harbor-atif-v1.7.schema.json` and mirrored in `src/atif.ts` enforces Harbor model-level rules:

1. **Sequential 1-Based Step IDs**: Step identifiers start at `1` and increment contiguously without gaps (`step.step_id === index + 1`).
2. **Source-Specific Field Rules**:
   - `model_name`, `reasoning_effort`, `reasoning_content`, `tool_calls`, and `metrics` are allowed **only** when `source === "agent"`.
   - When `source === "agent"` and `llm_call_count === 0`, `metrics` and `reasoning_content` must be absent.
3. **Strict ISO-8601 Timestamps**: Timestamps must parse to valid finite dates.
4. **Tool Call & Observation Linkage**: Every `observation.results[].source_call_id` must match a `tool_call_id` defined in the same step.
5. **Subagent Tree Resolution**:
   - Every embedded subagent trajectory must declare a non-empty, unique `trajectory_id`.
   - Any `subagent_trajectory_ref` containing a `trajectory_id` must resolve to an existing embedded subagent trajectory or specify an external `trajectory_path`.

### ATIF Export Envelope (`quasar.trajectory.atif-export/v1`)

The output produced by `quasar trajectory --format atif` packages the Harbor trajectory alongside full compatibility and audit metadata:

```json
{
  "format": "quasar.trajectory.atif-export/v1",
  "schemaVersion": "ATIF-v1.7",
  "schemaId": "https://github.com/harbor-framework/harbor/tree/7db020ba5a5ceee918351dd8fc374d4d60bad442/src/harbor/models/trajectories#ATIF-v1.7",
  "sourceProtocolVersion": "quasar.normalized-session/v1",
  "schemaSource": {
    "repository": "https://github.com/harbor-framework/harbor",
    "commit": "7db020ba5a5ceee918351dd8fc374d4d60bad442",
    "modelPath": "src/harbor/models/trajectories/trajectory.py",
    "validatorPath": "src/harbor/utils/trajectory_validator.py"
  },
  "trajectory": { ... },
  "compatibility": {
    "valid": true,
    "validator": "quasar.atif-v1.7-mirror",
    "checks": [
      "strict_fields",
      "source_specific_fields",
      "iso_timestamps",
      "sequential_step_ids",
      "tool_result_references",
      "subagent_reference_resolution",
      "embedded_subagent_ids"
    ],
    "counts": { ... },
    "entries": [ ... ]
  }
}
```

Compatibility entries track mappings with status codes:
- `mapped_core`: Direct structural mapping to standard ATIF fields.
- `mapped_extension`: Preserved in `extra` extension bags.
- `omitted_by_policy`: Excluded per user projection flags (`--exclude-reasoning`, `--exclude-tool-results`).
- `unobserved_atif_field`: ATIF specification fields not emitted by the source provider.
- `projection_adjustment`: Payload adjustments (e.g. byte truncations).

---

## Letta Trajectory Export Schema (`quasar.trajectory.letta-export/v1`)

Projects Quasar sessions into the [Letta Trajectory v1](https://letta.ai/schemas/trajectory/v1.json) interchange format.

- **Schema ID**: `https://letta.ai/schemas/trajectory/v1.json`
- **Export Envelope**: `quasar.trajectory.letta-export/v1`

### Role Mappings & Invariants

Letta trajectories consist of an array of records starting with a session-level `meta` record:

1. **`meta`**: Declares source provider (`source`), working directory (`cwd`), git branch (`git_branch`), and model (`model`).
2. **`user`**: User conversational turn (`content`, `timestamp`).
3. **`reasoning`**: Chain-of-thought text (`content`, `timestamp`).
4. **`assistant`**: Assistant message. Enforces the Letta structural invariant:
   - Text message: `content` is a non-empty string.
   - Tool execution: `content` must be `null` and `tool_calls` must be a non-empty array of `{ id, name, args }`.
5. **`tool`**: Tool result turn (`tool_call_id`, `content`, `timestamp`).

### Compatibility Issue Classification

The export envelope reports all semantic transformations required to satisfy Letta v1 constraints:

- `mixed_assistant_split`: Emitted when an assistant turn had both visible prose and tool calls (split because Letta requires `content: null` when `tool_calls` are present).
- `event_meta_omitted`: Preamble, developer, or system event excluded because Letta v1 has no turn-level meta record.
- `missing_or_invalid_timestamp`: Unobserved source timestamps flagged without fabricating synthetic dates.
- `quasar_metadata_omitted`: Quasar project keys, assignments, lineage, and normalization versions omitted.
- `tool_result_truncated`: Tool payload truncated per `--tool-result-max-bytes`.
- `tool_call_timestamps_coalesced`: Distinct parallel tool timestamps collapsed to the parent assistant record timestamp.

---

## Quasar Agent Trajectory Schema (`quasar.trajectory/v1`)

The native agent-readable trajectory projection designed for LLM consumption, agent evaluation, and replay.

### Record Types & Source Links

1. `TrajectorySessionMetaRecord` (`role: "meta"`, `category: "session"`): Session origin, project key, provider, assignment, and model metadata. Always record `0`.
2. `TrajectoryEventMetaRecord` (`role: "meta"`, `category: "event"`): Preamble, system instructions, or summaries.
3. `TrajectoryUserRecord` (`role: "user"`): User turn text.
4. `TrajectoryAssistantRecord` (`role: "assistant"`): Assistant response text.
5. `TrajectoryReasoningRecord` (`role: "reasoning"`): Thinking / reasoning blocks.
6. `TrajectoryToolCallRecord` (`role: "tool_call"`): Tool invocation name and arguments.
7. `TrajectoryToolResultRecord` (`role: "tool_result"`): Executed tool output, original/returned byte counts, content hash, and truncation status.

### Loss Reporting & Full-Read Pointers

Every trajectory record and omitted source fact contains a deterministic `fullRead` pointer:
- `session-detail`: Points to `quasar session --id <sessionId>`
- `tool-call`: Points to `quasar tool-call --id <toolCallId>`

Omitted and truncated facts are recorded in the `losses` array with explicit reasons:
- `omitted`: `excluded_by_option`, `not_selected_for_agent_projection`, `unsupported_content_block`
- `truncated`: `tool_result_truncated`

---

## Research Export Frame Schema (`quasar.research-export/v1`)

Defines the NDJSON streaming format for large-scale, snapshot-bound, reproducible research datasets.

### NDJSON Frame Protocol

A research export stream consists of five strict frame types:

1. **`manifest`**: Stream header declaring dataset snapshot hash, query filters, page limits, trajectory scope, and projection options.
2. **`message`**: Individual conversational turn metadata and text (`messageId`, `sessionId`, `sequence`, `role`, `text`, `projectKey`, `provider`, `model`).
3. **`trajectory`**: Complete `QuasarTrajectory` for the first matching message of each represented session.
4. **`receipt`**: Stream footer containing total message count, trajectory count, content byte size, SHA-256 hash, and continuation scan key (`next`).
5. **`error`**: Fail-closed error payload if the stream encounters an unrecoverable fault.

### Deterministic Ordering & Checksum Receipts

- Messages are ordered strictly by ascending `(sessionId, sequence)` scan keys.
- The `receipt` frame verifies the exact SHA-256 hash of all streamed data lines.
- Pagination is resumable across shards using opaque Base64URL-encoded cursors bound to the immutable corpus snapshot.

---

## Query & Response Schemas

### QuerySpec (`quasar.query/v1`)

Unified query input shared across CLI, MCP tools, and HTTP endpoints:

- `SearchQuerySpec`: `kind: "search"`, `text`, `mode` (`lexical` | `semantic` | `fusion`), `filters`, `projection`, `page`.
- `SessionsQuerySpec`: `kind: "sessions"`, `filters`, `projection`, `page`.
- `MessagesQuerySpec`: `kind: "messages"`, `filters`, `projection`, `page`.
- `ToolCallsQuerySpec`: `kind: "toolCalls"`, `filters`, `projection`, `page`.

### QueryResponse (`quasar.query-response/v1`)

Enforces exact projection equality: every item in the `items` array must contain **precisely** the fields requested in `projection.fields`, no more and no less. Pagination is cursor-based via `page.nextCursor`.

---

## Session Enrichment Schema (`quasar.session-enrichment/v1`)

Defines namespaced derived analysis (e.g. summaries, evals, topic tags) attached to sessions:

```json
{
  "protocolVersion": "quasar.session-enrichment/v1",
  "sessionId": "codex:01950e93-9c87-7359-bb43-d9d150247656",
  "namespace": "quasar.analysis.eval",
  "schemaVersion": 1,
  "producer": "thread-analyzer@1.0.0",
  "inputHash": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
  "payload": {
    "summary": "Session repaired turn context loss.",
    "score": 0.98
  },
  "updatedAt": "2026-08-17T21:00:00.000Z"
}
```

- **Namespace Pattern**: `^[a-z0-9][a-z0-9._/-]*$`
- **Immutability Guarantee**: Re-ingesting raw source sessions will never alter or overwrite existing enrichment records.
