# Quasar — Data-Reality Plan

Date: 2026-06-11; updated 2026-06-18 for the Effect server direction.
Status: **canonical evidence**. This document owns measured corpus reality, provider
mapping rules, and the normalized entity model. The implementation architecture lives in
[quasar-effect-server-plan-2026-06-18.md](quasar-effect-server-plan-2026-06-18.md).
Provenance: owner decisions of 2026-06-11 after a full-corpus measurement (every file
and row of all five providers parsed), superseding the v2 greenfield plan and the
sync-contract/stop-line apparatus.

## Product sentence

Agents assess and research sessions for a project via deep session inspection and
targeted tool-call retrieval in a fast CLI, MCP tools, and a local server. SQLite stores
the session rows and durable queue. (2026-06-11 snapshot: the LanceDB search
substrate described in this document was replaced by SQLite FTS5 plus a resident
vector matrix on 2026-07-04 — see quasar-first-principles-rearchitecture-2026-07-03.md.
The corpus measurements and entity model below remain the live evidence.)

## The data reality (measured 2026-06-11)

| Provider | Raw source | Sessions | Product text (UA + tool in/out) |
| --- | ---: | ---: | ---: |
| claude   | 142 MB JSONL | 794 | ≈ 35 MB |
| codex    | 685 MB JSONL | 589 (472 `sessions/` + 117 `archived_sessions/`) | ≈ 240 MB |
| opencode | 856 MB SQLite | 881 | ≈ 300 MB (+129 MB plaintext reasoning) |
| hermes   | 91 MB SQLite | 77 | ≈ 20 MB |
| grok     | 20 MB files | ~20 | ≈ 5 MB |
| **total** | ≈ 1.8 GB | ≈ 2,360 | **≈ 650 MB** |

Hard facts that bound all design:

- **No legitimate session value over 1 MB exists anywhere.** Worst real payload:
  185 KB (codex tool output). A session is context-window-bounded; a single turn
  physically cannot approach the storage boundaries that matter for this project.
  Anything that does is provider garbage (e.g. the infamous 105 MB opencode `message`
  row — agent machinery, not session data).
- The infamous 42 GB was the blob-import architecture's own amplified state, never
  source data. Amplification in the record-stream era was self-inflicted schema
  overhead (identity fields = 47.7% of wire bytes), never the data.
- Claude Code purges transcripts after 30 days by default (`cleanupPeriodDays`; set to
  3650 on this machine 2026-06-11). Quasar ingest is the preservation layer.

**The lesson all five failures share: profile the dataset before designing storage.**
Any future shape decision starts from a measurement of real data, in absolute MB.

## Three principles

1. **Measured data is the contract.** No invented caps, clamps, gates, ratios, or byte
   budgets — ever. A value beyond measured session reality is, by the physics above,
   provider garbage: emit a named diagnostic `(provider, sessionId, field,
   observedBytes)`, write zero rows for that session, continue the run. Boundary
   rejection, never "robust handling."
2. **Store at the grain you read.** Rows are turns. Reading a session is a paginated
   index walk in `seq` order. No chunking, no compaction, no reconstruction layer.
3. **Indexing is a separate decision from storing.** SQLite stores the canonical rows;
   LanceDB owns the search index and its indexing state. Search surfaces and structural
   retrieval surfaces are different tables. Tool payloads (an agent reading 100 files)
   can never pollute session search, structurally.

## Entity model and schema

Single tenant — no user/org. `project → session → turns`, with the turn union split
into purpose-built tables (we serve Quasar's read paths, not a provider wire format):

```
projects   projectKey (canonical cross-provider via core resolveProjectIdentity:
           explicit key → git remote → package → workspace → path), displayName,
           aliases[], rawPaths[]                            index: by_projectKey

sessions   sessionId, projectKey, provider, agentName, title, startedAt, updatedAt,
           sourcePath, sourceFingerprint (size+mtime), messageCount, toolCallCount
                                              indexes: by_sessionId, by_projectKey

messages   sessionId, seq, role (user|assistant|reasoning), text, ts, projectKey
           index: by_sessionId_and_seq
           — source rows for LanceDB indexing

toolCalls  sessionId, seq, toolName, status, inputText, outputText,
           startedAt, completedAt, projectKey, provider
           indexes: by_sessionId_and_seq, by_projectKey_and_toolName
           — structural surface; NEVER search-indexed, NEVER embedded
```

Tool inputs and outputs are stored **in full** unless the provider row is diagnosed as
garbage by measured session reality. Use case for `toolCalls`: "grab all calls to tool
X in project Y and analyze inputs/outputs" — an exact index walk, not a search.

## Turn-mapping rules per provider

- **claude** (`~/.claude/projects/**/*.jsonl`): `text` blocks of user/assistant
  messages → `messages`; plaintext `thinking` blocks → `role: "reasoning"`;
  `tool_use`/`tool_result` → `toolCalls`.
- **codex** (`~/.codex/sessions/` **and** `~/.codex/archived_sessions/`): read
  `response_item` only — `event_msg` rows duplicate the same content (18.7 MB
  measured) and are never ingested. Skip injected wrappers from `messages`
  (`<environment_context>`, `<user_instructions>`, `<turn_aborted`, `<ide_context`,
  permissions preambles): no human authored them. Codex reasoning is
  encrypted/summarized → skip (rule: ingest what the user saw and the agent worked
  with). `function_call`/`local_shell_call`/`custom_tool_call` → inputText;
  `*_output` → outputText.
- **opencode** (`opencode-local.db`, adapter picks the higher-session-count db):
  `text` parts → messages; `reasoning` parts (plaintext) → `role: "reasoning"`;
  `tool` parts → toolCalls from `state.input`/`state.output`. `step-start`/
  `step-finish`/`compaction`/`file`/`patch` parts are not session turns → skip. The
  105 MB message row must surface as a named diagnostic with zero rows. Keep the
  adapter's existing SQL pruning guards. Read-only, no locks that stall a live agent.
- **hermes** (`~/.hermes/state.db`): sessions + messages tables; hermes-internal FTS
  tables ignored. Read-only, WAL-safe.
- **grok** (`~/.grok/sessions/*/`): chat/summary/events/updates; `hunk_records` are
  diff machinery → skip.

Redaction (`redactSensitive` in core) is a mandatory line on every ingested text.

## Ingest pipeline

`quasar ingest --provider <p>`: adapter stream → turn mapping → redaction → SQLite
truth-store write → durable downstream jobs for indexing and embeddings. Batches are
bounded by runtime memory and SQLite transaction behavior, not by a remote argument
transport. Idempotency: unchanged `sourceFingerprint` skips the session; changed
sessions replace their stored turns atomically. Run reports speak absolute numbers:
sessions written/skipped, rows, MB, diagnostics, duration, and queued derived work.

## Search

LanceDB owns the search stack on the Mac mini filesystem. It gets explicit indexing
state, invalidation rules, FTS/vector indexes, freshness reconciliation, and
verification batteries. It is derived from SQLite truth and can be rebuilt.

## Build sequence (Tower, project `quasar`, forge orbit)

Current work continues in Tower with the Effect server sequence: SQLite truth
store, durable queue, LanceDB indexing/search, embedding cache, Docker/Tailscale
deployment, then full-corpus proof.

## Historical documents

The v2 greenfield plan, sync-contract draft, stop-line decision packet, byte-budget
reports, and reset report are historical evidence of the failed eras — banner-marked,
minable, never live instructions. The sync-contract code artifacts were deleted from
the tree at QSR-053; mine git history if ever needed.
