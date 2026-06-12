# QSR-060 — Semantic/Fusion Search Proof

Date: 2026-06-12
Backend: self-hosted Convex via local Quasar launchd deployment (`http://127.0.0.1:3217`, Tailscale-routed externally)
Model: `gemini-embedding-2`, 1536 dimensions
Embedding surface: `messages` rows with role `user` or `assistant` only
Excluded surfaces: `reasoning` messages and all `toolCalls`

## Verdict

Semantic search is live on the self-hosted backend, fusion search combines lexical and vector hits, and the embedding lifecycle is server-owned:

| Check | Verdict | Evidence |
| --- | --- | --- |
| Convex RAG component | PASS | `convex.config.ts` mounts `@convex-dev/rag` and `@convex-dev/workpool`; `convex/quasarRag.ts` wires Gemini `gemini-embedding-2` at 1536 dims. |
| Server-owned embedding | PASS | `commitSessionIngest` schedules `scheduleSessionEmbedding`; backfill is `internal.embed.scheduleEmbeddingBackfill`; no CLI/MCP command can trigger embedding. |
| Role purity | PASS | `convex/embed.ts` can only express `user`/`assistant` via `embeddableRoleValidator`; `bun run verify` includes the convex-lint embedding-surface rule and role-purity tests. |
| Backfill status | PASS | Inline Convex query over `sessions`: `{ total: 2458, embedded: 2458, claimed: 0, ingest: 0, pending: 0 }`. |
| Semantic search | PASS | CLI semantic query returned `semanticStatus: "ready"`, `embeddingDimensions: 1536`, `semanticSearched: true`. |
| Fusion search | PASS | CLI fusion query returned both `textSearched: true` and `semanticSearched: true`, with `textRank` and `vectorRank` on fused matches. |
| Structural retrieval | PASS | `quasar tool-calls list --project git:github.com/skastr0/quasar --provider codex --limit 2` returned full input/output tool-call rows. |
| Permanent validation | PASS | `bun run verify` passed static tests, convex tests, convex lint, reconciliation, relevance, and fidelity checks. |

## Server-owned embedding architecture

The correct model is now encoded in Convex, not delegated to clients:

- `convex/quasar.ts` calls `scheduleSessionEmbedding` from `commitSessionIngest` after an ingest claim is committed.
- `convex/embed.ts` owns the Workpool (`maxParallelism: 2`, retries enabled) and enqueues `internal.embed.embedSession`.
- `internal.embed.scheduleEmbeddingBackfill` walks session embed state and enqueues only sessions whose `embeddedFingerprint` differs from `sourceFingerprint`.
- `claimSessionEmbedding` and `markSessionEmbedded` make scheduling idempotent and supersession-safe.
- The CLI and Prism MCP plugin expose search/session/tool-call/client operations only; they do not expose embedding or backfill controls.

## Backfill state

Read-only Convex inline query, using the current local backend admin credentials from `~/.config/quasar/local/default/config.json` without printing secrets:

```json
{
  "claimed": 0,
  "embedded": 2458,
  "ingest": 0,
  "pending": 0,
  "total": 2458
}
```

Interpretation: every currently stored session has `embeddedFingerprint === sourceFingerprint`; no ingest claims or embedding claims remain outstanding.

## Semantic/fusion smoke

Command:

```sh
quasar search --query 'embedding backfill cost Gemini spend dollars pendingUnclaimed' --mode fusion --project git:github.com/skastr0/quasar --limit 5
```

Relevant diagnostics:

```json
{
  "embeddingDimensions": 1536,
  "semanticSearched": true,
  "semanticStatus": "ready",
  "textSearched": true
}
```

Returned fused matches carried both `textRank` and `vectorRank`, including the prior embedding reconnaissance and semantic-proof sessions for Quasar.

Command:

```sh
quasar search --query 'why did we reject byte budgets and chunking robust handling' --mode semantic --project git:github.com/skastr0/quasar --limit 5
```

Relevant diagnostics:

```json
{
  "embeddingDimensions": 1536,
  "semanticSearched": true,
  "semanticStatus": "ready",
  "textSearched": false
}
```

The semantic-only results returned Quasar sessions about byte-budget/chunking failure modes without relying on lexical search.

## Structural tool-call surface

Command:

```sh
quasar tool-calls list --project git:github.com/skastr0/quasar --provider codex --limit 2
```

Returned two Codex `exec_command` rows with full `inputText` and `outputText`. This confirms structural questions are answered through the `toolCalls` surface, not through semantic search or embeddings.

## Permanent validation run

Command:

```sh
bun run verify
```

Tail evidence:

```text
CONVEX LINT: PASS — 6 file(s) conform to the grain rulings.
RECONCILIATION: PASS — every provider within documented tolerance.
PINNED RELEVANCE: PASS — 16 fixtures across 5 providers / 8 projects.
READ FIDELITY: PASS — 10 sessions, every divergence classified.
verify:live: all live batteries green.
```

## Accepted operational note

The current Amp session still had a stale in-memory generated MCP wrapper during the rollout, so live MCP tool calls in this already-open session could still use the old argument shape. The generated Prism plugin files on disk were refreshed and verified separately; new Amp sessions should load the corrected wrappers. The source-of-truth CLI path and generated plugin source are aligned.
