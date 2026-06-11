# Convex Grain — Quasar v2 Verdicts

Date: 2026-06-10. Verified against live official docs (limits page, Zen/best-practices,
text/vector search docs, self-hosted README + Stack self-hosting guide). General Convex
guidance (Zen rules, full limits table, self-hosted ops, anti-grain warnings) lives in the
global `convex` skill; this doc holds the **Quasar-v2-specific rulings** that adjust the
greenfield plan (`quasar-v2-greenfield-plan-2026-06-10.md`).

## Hosting decision recap

Convex **self-hosted on this machine**, Docker Compose (backend `:3210`, HTTP actions
`:3211`, dashboard `:6791`), SQLite persistence, pinned image tag, `npx convex export`
before every upgrade, served to agents over Tailscale. Self-hosted supports all free-tier
features (official statement); components support follows from that parity but lacks an
explicit confirmation sentence — **verify the RAG component on the self-hosted backend in
the beachhead glyph before anything depends on it.**

## Verdicts on v2 plan assumptions (each checked against current limits)

**(a) Envelopes ≤512 KiB / ≤800 records — legal, but chunk the mutations.**
Limits give huge headroom (16 MiB args, 16k docs written/mutation), but mutations have a
**1-second execution cap** and the Zen budget is "< a few hundred records, < 100ms."
Ruling: keep the 512 KiB envelope at the transport level; the receiving path commits in
chunks of **~200–400 records per mutation**, checkpointing progress per chunk. On a
single-writer ingest path OCC conflicts are unlikely — this is about the 1s cap, not
contention.

**(b) Search index on ~453k message docs with filter fields (project, role, kind) — yes.**
No documented per-index doc-count or size cap; binding constraints are per-query (1,024
docs scanned/returned, 16 terms, 8 filter clauses). Use **`staged: true`** when adding the
search index to a pre-populated table (async backfill). Mind the 32-indexes-per-table
total (db + search + vector combined).

**(c) Vector index at message granularity, 150–250k vectors — yes; prefer 1536 dims.**
Dimensions 2–4,096 allowed; no published vector-count cap. 256 max results/query is
plenty for RRF (fetch top-64/128 per leg). At 250k vectors: 1536 dims ≈ 2.9 GB vs 3072 ≈
6 GB of float64 — on a single Mac with SQLite persistence, **1536 unless retrieval quality
demands otherwise**. Store vectors in a side table so message docs stay lean for
pagination budgets.

**(d) Paginated session reads — exactly the blessed pattern.**
`.withIndex("by_session", …).paginate(paginationOpts)`; cap `numItems` and let the
CLI/MCP client loop cursors. Never `.collect()` a session's messages.

**(e) Embedding outbox + scheduled drain — textbook idiomatic.**
Mutation writes message + outbox row and `ctx.scheduler.runAfter`s an **internal action**;
the action takes a bounded batch, calls the embedding API, and commits via **one**
internal mutation that marks outbox rows done (idempotent checkpointing). A cron sweeps
stragglers. Do not chain multiple `ctx.runMutation` calls per batch. Raise
`APPLICATION_MAX_CONCURRENT_*` knobs up front (community-reported crash at >16 concurrent
actions on self-hosted, github issue #391).

**(f) Ingest entry: prefer `ConvexHttpClient` → public mutation over an HTTP action.**
The CLI is a trusted local client; calling a public mutation directly is more idiomatic
(argument validators do the parsing; less hand-rolled auth/retry). Caveat: self-hosted
has no scoped deploy keys — the admin key grants everything, including internal
functions. Ruling: public ingest mutation guarded by an in-function **shared secret**
argument + Tailscale-only network exposure; the admin key never leaves the server. The
ingest mutation must be **idempotent on envelope/record identity** because the caller
retries (v2's key-based always-write upserts already satisfy this).

**(g) Hybrid/fusion search endpoint must be an action.**
Vector search runs **only in actions**. Shape: action runs the vector leg, calls one
query for the text leg, fuses on IDs (RRF), hydrates only the final top-k via one query.
Note BM25 ties break by recency and the final term gets prefix matching (typeahead) —
fine for the product; fuzzy search no longer exists (deprecated 2025-01-15).

## Plan-doc adjustments these rulings imply

- §4 ingest endpoint: "POST /sync HTTP action" → CLI `ConvexHttpClient` calling a public
  mutation with shared-secret arg; transport envelope unchanged; server-side commit
  chunking at 200–400 records.
- §4 reads: searchText stays a query; **searchFusion becomes an action**.
- §4 embeddings: 1536-dim default; vectors in a side table; knobs set in the beachhead.
- Glyph 1 (beachhead) gains gates: self-hosted backend running under a pinned tag with
  restart policy; text + vector search verified working; **RAG component verified on
  self-hosted**; export/upgrade drill documented; reachable from a second tailnet device.
- Ops invariants: pinned image, export-before-upgrade, `--disable-beacon` optional,
  single-node accepted, disaster recovery remains `quasar sync --rebuild` from source
  files (the server stays disposable; exports are a convenience, not a dependency).

## Rulings from the installed Convex skill suite (added 2026-06-10)

The machine now carries official-style Convex skills (`convex-quickstart`,
`convex-performance-audit`, `convex-migration-helper`, `convex-create-component`,
`convex-setup-auth`, plus a routing `convex` skill) alongside `effect`. Reviewed against
the v2 plan; no decision is overturned. Refinements:

**(h) Beachhead additions.** Run `npx convex ai-files install` in the repo so the managed
official Convex guidelines are in place for every future agent (routing-skill
recommendation). Use `npx convex dev --once` as the agent validation loop (pushes schema +
functions, typechecks, regenerates types, exits cleanly). Verify whether
`npx convex insights --details` works against the self-hosted backend; if not, perf gates
fall back to code audit per the performance-audit skill.

**(i) Index-only read discipline, stated stronger.** Convex's own `.filter()` does NOT
push predicates to storage — it costs the same as JS filtering and still burns the
scanned-documents budget. Every v2 read path uses `.withIndex()` / `.withSearchIndex()`
only; `.filter()` is banned on tables that grow with the corpus. Also: no redundant
prefix indexes (`by_foo` + `by_foo_and_bar`) — the planned index set already complies;
keep it that way when adding filters.

**(j) Mutation batching pattern confirmed verbatim.** The 200–400-record commit chunks
and the cursor-continuation cascade delete are exactly the skill's "self-scheduling
internalMutation chain" pattern (function-budget reference). Note the 1s mutation cap
covers user code only (DB ops excluded), which gives slack — but chunking stays.

**(k) Hot-document and digest-table restraint.** Session-doc rollups (eventCount, usage)
are patched on every ingest envelope — acceptable because v2 has no reactive subscribers
(CLI/MCP are point-in-time readers via ConvexHttpClient) and a single writer. Per the
performance-audit guardrails: no digest/summary tables, no document splitting, no
structural work without a measured signal. (This guardrail is also the anti-pattern #9
antidote: it forbids speculative complexity in Convex's own official voice.)

**(l) Migration policy.** v2 cutover needs no migration machinery — no live data was ever
written (the migration-helper skill's own "greenfield schema" exclusion). Post-launch
breaking schema changes have two paths: (1) **wipe + `quasar sync --rebuild`** — preferred
while re-ingest is cheap, since source files are the fidelity store; (2)
**widen-migrate-narrow with `@convex-dev/migrations`** — adopt when rebuild stops being
cheap, which happens the moment embeddings are live (re-embedding ~150–250k messages costs
real API money; the embedding cache is server-only state that rebuild destroys). So: at
the embeddings glyph, either re-adopt the migrations component or add embedding-cache
export/import to the rebuild path. The reset deleted the migrations component for
protecting bad data; its eventual return is legitimate when it protects expensive-to-
recompute state.

**(m) Component boundary rules (for the RAG component and any future local component).**
Components cannot read `process.env` or `ctx.auth` — the app passes API keys/identity in
explicitly. Never expose component functions to clients; wrap in app functions.
`.paginate()` does not cross the component boundary (use `convex-helpers` paginator if
needed). Quasar's own outbox/ingest logic stays **app code**, not a component — the
component-authoring skill itself says prefer app code absent a reuse/isolation need.

## The one-line reconciliation with history

The 42 GB incident was our data shape, not Convex: we stored what no query consumed and
shipped blobs through a transactional engine. Every ruling above is the inverse move —
store only what queries consume, keep transactions small, let the sync engine do the
caching. That is "really understanding the opinionated architecture," operationalized.
