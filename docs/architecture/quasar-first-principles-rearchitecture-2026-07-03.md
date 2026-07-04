# Quasar — First-Principles Re-Architecture Map

Date: 2026-07-03.
Status: **design map** — the destination the eventual refactor lands in. The live
system (LanceDB, optimize off, manual reclaim) stays canonical until this is
scheduled. Companion to `quasar-effect-server-plan-2026-06-18.md`, whose service
graph and domain model survive unchanged; only the search substrate is re-derived
from the problem instead of inherited.

## Method

Everything below is derived from the measured problem — corpus, write shape, read
shape, latency bar — not from the existing code, not from component popularity,
not from any single reference implementation. Candidate architectures are swept
from the top; each rejection states its reason.

## 1. The problem, as measured invariants

| Dimension | Measured value (2026-07-03) |
| --- | --- |
| Source of truth | Harness session files on disk (~1.6 GB measured: 670 MB claude + 966 MB codex + others). Durable, append-mostly, owned by the harnesses. |
| Product text | ~650 MB across 669,190 messages, 13,399 sessions, 302 projects |
| Structural surface | 722,276 tool calls (stored, queryable, not embedded by default) |
| Vectors | 768-dim; 669k rows → **1.03 GB at f16** (2.06 GB f32); embedding cache 305,904 entries (content-hash dedup ≈ 2.2×) |
| Row shape | Small text rows; no legitimate value > 1 MB (boundary-rejected, AGENTS.md principle 1) |
| Write shape | Trickle: ~+9k messages/week (~1.4%/week), idempotent upserts keyed on content-derived identity; plus rare **bulk re-ingest** of the whole corpus |
| Read shape | Agent queries over Tailscale: single-digit concurrent, bursty, top-k with filters (projectKey, provider, role); plus structured reads (session pagination, tool-call forensics) |
| Latency bar | Instant — sub-100 ms server-side for every search mode (owner's bar; the corpus is tiny, any non-instant path is our bug) |
| Consistency | Single writer (one ingest daemon). Read-your-writes within seconds. Seconds-to-minutes freshness lag on newest sessions acceptable for semantic only. |
| Deployment | One node (Mac mini), Docker, one volume, Tailscale mesh. No multi-tenant, no replication. |
| Features that must survive | lexical / semantic / fusion search; filters; pagination; session reads; tool-call forensics; MCP + CLI + TUI behind the existing HTTP contract; future multimedia embedding |

## 2. First-principles reframes

These five reframes do most of the work; the component choices fall out of them.

### R1 — The database is a cache. Everything is derived.

The real source of truth is the harness session files. Every layer below them is a
materialized view of the layer above:

```
harness files (~1.6 GB, durable, not ours)
  → normalized rows            (SQLite: projects/sessions/messages/toolCalls)
    → lexical index            (FTS5, trigger-maintained — fresh at COMMIT)
    → vector matrix            (RAM-resident, boot-loaded from blobs)
  → embedding cache            (the ONLY expensive-to-recompute artifact)
```

Consequences:
- **"Readiness" dissolves.** Each view either exists or is being materialized.
  Lexical is transaction-fresh by construction (trigger), so it can never be
  "not ready". Semantic freshness is a watermark; behind-watermark degrades to
  lexical-only, never 503.
- Durability requirements collapse: everything is rebuildable by one command.
  With local embeddings (R5) even the cache is cheap to rebuild; the system has
  **no state whose loss is expensive**.
- Repair tooling is one verb: `rematerialize <view>`.

### R2 — The scale class is "one process's memory".

Text + vectors + indexes together are ~3 GB. Every database engine that exists to
avoid RAM residency — columnar layouts, compaction, LSM trees, disk-ANN,
partitioned indexes — is paying for a problem this workload does not have. The
month of operational pain was the operational model of those engines, imported
for nothing. Choose in-process everything; concurrency is one writer + WAL
readers.

### R3 — Two write modes deserve two code paths, never mixed.

- **Streaming trickle** (steady state): synchronous, per-row, trigger-maintained,
  zero background machinery. Cheap because rows are tiny.
- **Bulk rebuild** (re-ingest, re-embed, index rebuild): build-aside into a
  staging artifact, atomic swap, delete old. Deliberate, watched, idempotent.

Every disk explosion in the project's history was one mode's machinery running at
the other mode's cadence (per-batch `createIndex`; `optimize()` every 2 min).
The architecture makes the confusion impossible: the streaming path *has no*
expensive operations, and the bulk path *only* runs when invoked.

### R4 — At this scale, exact search dominates ANN. No vector index at all.

Arithmetic: 669k × 768 × 2 B (f16) = 1.03 GB. One full sweep at Apple-silicon
memory bandwidth (~100–200 GB/s) is 5–10 ms theoretical; a SIMD f16 dot-product
kernel across cores lands in the tens of milliseconds practical. That is:

- **at or under the latency bar** — parity with any ANN index;
- **recall 1.0** — strictly better than HNSW/IVF-PQ (0.9x);
- **exact filtered search for free** — pre-filter candidate ids in SQL, mask the
  scan. Filtered ANN is a notoriously hard problem (pre- vs post-filter recall
  loss); our queries filter by projectKey/provider/role constantly. Brute force
  is not "good enough" here — it is *better* for this feature set;
- **zero index state** — nothing to build, stage, swap, optimize, GC, or trust.
  The vectors are the index. Boot = load blobs (~1–2 s from NVMe); ingest =
  append a row to the matrix.

Implementation note: the kernel must be native (usearch exact mode, simsimd, or a
tiny N-API kernel over Accelerate) — pure-JS dot products would blow the budget.
One small, stateless native dep.

### R5 — Embeddings are compute, not a service dependency.

The corpus embeds with `nomic-embed-text-v1.5` — open weights, runs locally via
ONNX (fastembed / onnxruntime) on the mini. Local embedding:
- removes the external API from the ingest path (the current 1,819 dead-lettered
  embed jobs are this dependency's failure class);
- makes full-corpus re-embedding a minutes-to-an-hour operation, which makes
  vectors *actually* disposable (R1) — "re-embed all" becomes the repair tool;
- preserves the existing cache as replayable historical state, but does not trust
  mixed namespaces without proof. The 2026-07-04 local-ONNX parity receipt failed
  the 0.99 cosine gate against the synthetic/HF cache, so the landing path
  re-embeds into a new local namespace before semantic cutover.

Multimedia is the same reframe with a different encoder: media files live on the
volume filesystem (never in the database — only path + vector are stored); a
CLIP-class local model embeds them into the same vector table with a
`modality` + `model` namespace column; one resident matrix per namespace;
text→image queries go through the multimodal text encoder.

## 3. The architecture space, swept

| # | Candidate | Verdict | Reason |
| --- | --- | --- | --- |
| A | **No database**: files → in-memory everything, snapshot for boot | reject | Reinvents persistence, WAL, and a query engine for 722k tool-call forensics rows — badly — to avoid a dependency (SQLite) that costs nothing. Classic monster seed. Its correct insight — indexes as process state — is absorbed into the winner. |
| B | **SQLite (+FTS5) + resident f16 matrix, exact scan** | **adopt** | Meets every invariant with the least machinery; every derived layer rebuildable; zero background loops; ops = one file. |
| C | Postgres + pgvector + tsvector | reject (graduation) | Would work. But: an always-on server daemon for a 2 GB single-writer corpus; backup ceremony vs file-copy; ts_rank < BM25; pgvector HNSW re-imports index-build machinery. Named graduation target for genuine multi-user/multi-writer. |
| D | Meilisearch / Typesense (hybrid built in) | reject | A second stateful engine with its own compaction, its own opinions on fusion and filtering, its own ops model — the exact category of import that just cost a month. Still needs the truth store beside it. |
| E | Tantivy (native binding) + matrix | reject | Best-in-class BM25, but brings segment-merge machinery (compaction again) and a heavy native dep for no needed gain: FTS5 over 650 MB is single-digit ms. |
| F | DuckDB (FTS + array ops) | reject | Columnar OLAP write shape; wrong for constant tiny idempotent upserts. |
| G | LanceDB used properly: nightly build-aside dataset + symlink swap, immutable artifact | reject | Honest mention — this usage pattern (batch, R3-bulk-only) is what LanceDB is actually for, and it would hold. But it retains the dependency whose maintenance panics in Rust on our data, for zero capability the matrix doesn't give at this scale. |
| H | cass-copy: HNSW in-process | defer | Right answer at 10M+ vectors. At 660k it adds insert/rebuild machinery and recall loss for latency we already beat exactly. It is the *pre-decided graduation step*, not the start. |

## 4. The landing architecture

```
truth-cache  :: SQLite (WAL), one file, one volume
                 projects / sessions / messages / toolCalls / ingest ledger /
                 DurableQueue (embed jobs only) / embedding cache /
                 message_vectors (sessionId+seq PK, f16 BLOB, model, modality,
                 contentHash)
lexical      :: FTS5 virtual table (porter/unicode61), trigger-maintained.
                 BM25 ranking. Fresh at COMMIT. Never gated.
semantic     :: resident f16 matrix per (model, modality) namespace, loaded at
                 boot from message_vectors, appended on ingest. Exact SIMD scan
                 (native kernel). Watermark = max(sessionId,seq) loaded;
                 behind-watermark ⇒ degrade to lexical-only, never 503.
fusion       :: RRF over the two lists, app code, ~zero cost.
filters      :: lexical: indexed scope tokens inside MATCH; semantic: SQL
                 candidate set → mask on the scan. Exact.
embeddings   :: local ONNX (nomic-embed-text-v1.5) in the Effect embed worker;
                 content-hash cache retained. Remote API optional fallback.
multimedia   :: media blobs on the volume FS; CLIP-class local encoder; same
                 vector table + namespace; per-namespace matrix.
serving      :: unchanged — Effect HTTP server, ManagedRuntime, bounded fibers,
                 the 2026-06-18 service graph; CLI/MCP/TUI behind the existing
                 HTTP contract, untouched.
bulk ops     :: rematerialize verbs (re-ingest, re-embed, rebuild-fts), each
                 build-aside + atomic swap, manual or slow-cron, watched.
```

**What ceases to exist** (deleted, not deprecated): the LanceDB dependency and
data directory; `SearchService`'s Lance half; the readiness gate and its
classifier; the reconcile worker; the index-repair worker; the maintenance
service's optimize/GC; `gcSupersededIndexDirs` and all reclaim scaffolding;
`index-session` queue jobs (lexical indexing becomes the ingest transaction
itself). The worker fleet reduces to: embed worker. The failure taxonomy of the
past month — index generations, compaction, versions, watermark lies, 503
storms, disk amplification — has no representation in the system.

## 5. Features and performance, preserved or improved

| Surface | Today (live, measured) | Landing | Delta |
| --- | --- | --- | --- |
| lexical | 0.11–0.7 s | Scoped FTS5 BM25: project/role tokens inside MATCH, measured p95 22–37 ms and p99 24–65 ms on hit-bearing filtered queries | better |
| semantic | 0.34–1.3 s, ANN recall < 1, tail unindexed | exact scan, recall 1.0, no tail concept; latency gate still open because the current usearch f32 proof is seconds-level | better only after native-kernel gate |
| fusion | ~0.06–0.9 s | lexical + semantic + RRF target < 100 ms after semantic kernel gate | better only after semantic gate |
| filtered search | ANN filter semantics | exact | better |
| freshness | watermark + gate + reconcile | lexical: transactional; semantic: append-on-ingest | simpler, stricter |
| session / tool-call reads | SQLite | unchanged | — |
| ingest | CLI adapters → HTTP | unchanged | — |
| disk | 12 GB for ~3 GB of real data; creeps; manual reclaim; panic risk | corpus-proportional (~4–5 GB incl. FTS + vectors); no amplification mechanism exists | better |
| backup | none defined | copy one file (+ media dir) | new |
| boot | container start | + ~1–2 s matrix load | negligible |
| memory | — | + ~1.2 GB resident (matrix + overhead) | fine on the mini |

## 6. Pre-decided graduation triggers

Written down now so the future decision is a lookup, not a council:

- vectors > ~5 M or matrix > ~8 GB → HNSW (usearch), staging-file + fingerprint
  + atomic swap (the cass pattern), still in-process.
- sustained > ~20 QPS or a second writer → Postgres + pgvector class.
- text corpus > ~5 GB or FTS5 p99 > 100 ms → Tantivy class, build-aside.
- multi-node serving → the whole design re-derives; do not extrapolate this one.

## 7. Migration shape: parallel build, then one switch

No watchdog, no week of quiet evidence, no layered flag maze. The new system is
built beside the old one, tested against an isolated SQLite copy and a fixed query
suite, then switched at the single search-provider boundary.

1. Build the SQLite-first search implementation separately: scoped FTS table,
   `message_vectors`, local embedding namespace, resident matrix, and fusion. It
   can use the same normalized rows, but it does not write LanceDB and LanceDB does
   not write it.
2. Run the corpus proof suite against that implementation: FTS hit/no-hit latency,
   cache coverage, local re-embed/replay, exact-scan kernel correctness and
   latency, and HTTP/CLI/MCP contract parity.
3. If every hard gate passes, switch the server's search provider once. The old
   LanceDB path remains untouched until this point, as an external fallback, not
   as a pile of interleaved runtime modes.
4. In the same productization slice, delete LanceDB, readiness/reconcile/reclaim,
   and obsolete queue jobs. Delete what the switch replaces; do not carry
   compatibility scaffolding forward.

## 8. Failure modes of the target system (named now, not discovered later)

The operational failure classes (compaction, versions, index generations, GC,
readiness divergence) have no representation. What remains is ordinary code-bug
surface, each with a named mitigation:

- **Matrix/SQLite coherence** — the resident matrix missing rows or stale vs
  `message_vectors`. Mitigation: watermark derived from one SQL query at boot;
  cheap count-parity invariant checked at boot and on interval;
  `rematerialize semantic` heals unconditionally.
- **FTS5 trigger coherence** — UPDATE/DELETE paths desyncing the virtual table;
  MATCH query-syntax errors on hostile user queries (escaping). Fully
  deterministic; covered by unit tests against a real SQLite file.
- **Native kernel** — wrong SIMD results or platform build failure (linux/arm64
  container). Mitigation: property-test against a naive pure-JS reference
  (exact up to f16 tolerance); pinned version; build in CI for the target arch.
- **Local ONNX drift** — same weights, different runtime can yield slightly
  different vectors than the 305k Synthetic-cached ones. Mitigation: measured
  parity sample (cosine ≥ threshold) before trusting mixed vectors; if drift,
  re-embed all under a new cache namespace — cheap by construction (R5).
- **Memory envelope** — matrix + ONNX model ≈ ~1.7 GB resident; growth is
  corpus-proportional and observable; the >8 GB graduation trigger bounds it.
- **Single-writer discipline** — long transactions vs WAL readers (busy
  timeouts). Standard SQLite hygiene; deterministic to test.
- **Ranking quality** — the one taste-bound risk (BM25+RRF vs today's fusion).
  Not unit-testable; covered by a fixed parity query suite before the single
  provider switch.

## 9. Testing story

SQLite is in-process — no testcontainers needed: tests open a real database
file (or `:memory:`) directly, at full fidelity, in milliseconds. The entire
truth + lexical + fusion + watermark core sits in the strongest backpressure
tier (deterministic pass/fail):

| Layer | How tested | Fidelity |
| --- | --- | --- |
| migrations, triggers, FTS coherence, MATCH escaping | unit tests on real SQLite | full |
| RRF fusion, filter masking | pure functions — property tests | full |
| watermark / boot load / rematerialize | real DB + real matrix in-test | full |
| native kernel | property-test vs pure-JS reference on random vectors | full (± f16) |
| embeddings | golden vectors per model version + local-vs-cache parity sample | high |
| HTTP contract | existing boundary tests carry over unchanged | full |
| rebuild-from-truth | existing "drop derived, rebuild, search returns" pattern | full |
| ranking quality, months-scale memory | shadow mode on live corpus + observation | the honest residue |

The residual bug risk concentrates in the two native deps (kernel, ONNX) and in
ranking taste — exactly where review/verification spend should go.

## 10. Proof addendum, 2026-07-04

Receipts:
- `docs/proofs/sqlite-fts-filtered-hit-benchmark-2026-07-04.json` proves the
  naive shape is not good enough: hit-bearing filtered FTS with SQL predicates
  landed at p95 104–506 ms.
- `docs/proofs/sqlite-fts-scoped-hit-benchmark-2026-07-04.json` proves the
  scoped shape: 683,010 rows, rebuild 32.1 s, p95 22–37 ms and p99 24–65 ms for
  four hit-bearing filtered queries.
- `docs/proofs/embedding-parity-cached-vs-local-2026-07-04.json` proves the
  cache is saved and replayable, but not namespace-compatible with local ONNX:
  678,250 eligible cached messages, 200-row sample, min 0.9237, mean 0.9620,
  p95 0.9718, threshold 0.99 failed. Preserve the old cache, re-embed local.
- `docs/proofs/sqlite-exact-scan-usearch-2026-07-04.json` proves full replayed
  vector scan over 678,249 candidates works functionally, but the current
  usearch f32 exact binding is not the final semantic kernel: p95 3.59 s, p99
  15.64 s at one thread.

Current go/no-go:
- **Go**: SQLite truth plus scoped FTS lexical search.
- **Go**: saved embedding cache as replayable source evidence.
- **No-go**: reusing the synthetic/HF cached vectors as the local ONNX semantic
  namespace.
- **No-go**: cutting semantic/fusion to the current usearch f32 exact scan.

Next hard gate: build the real resident vector kernel or a candidate-aware exact
scan path and prove sub-100 ms filtered semantic/fusion on the same corpus before
the single provider switch.
