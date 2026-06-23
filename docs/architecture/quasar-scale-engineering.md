# Quasar scale engineering — evidence ledger

Goal: Quasar ingests large corpora (target: orders of magnitude beyond the current
~180k-row / ~650MB local corpus) and serves search to many concurrent agents
without imploding, stalling, or serving garbage. **Rule: no change ships without
(1) an official doc citation, (2) research, and (3) measured test evidence.** This
file is the ledger — every claim below is reproducible.

Measurement environment: LanceDB `@lancedb/lancedb` 0.30.0 (embedded) inside the
quasar-server container; SQLite (bun:sqlite, WAL); nomic-embed-text-v1.5 via the
synthetic OpenAI-compatible API. Benchmarks run isolated in `/tmp` (never the live
corpus).

## Evidence ledger

### E1 — `mergeInsert` is NOT the ingest bottleneck (overturned a prior claim)
- Measured: incremental `mergeInsert` (the exact live-ingest API: `mergeInsert(key).whenMatchedUpdateAll().whenNotMatchedInsertAll()`) ingested 15,000 rows in **2.9s (~5,000 rows/s)**; bulk `add()` did the same in **0.3s (~45,000 rows/s)**.
- Conclusion: bulk `add()` is ~10× faster, but `mergeInsert` was never quadratic-catastrophic. The earlier "mergeInsert quadratic" claim was **false**.

### E2 — the per-session `sessionId` filtered read IS O(table) without a scalar index
- Measured (indexed table, read vs merge as it grows): the `WHERE sessionId = …` read (used by `deleteOrphans` + the no-clobber check) grew **2ms → 12ms** as the table went 1k → 12k rows — linear in table size. Merge stayed ~7–13ms.
- Conclusion: per-session reads are O(table) because there is **no scalar index on `sessionId`**. Over a full re-index this is O(sessions × table) = the real quadratic at scale.
- Fix (gated by E7): add a BTREE scalar index on `sessionId`. LanceDB docs: scalar indexes turn `WHERE` from full scan to indexed lookup. [^scalar]

### E3 — LanceDB FTS includes newly-added rows BEFORE `optimize()` (real-time lexical)
- Measured (30k-row FTS table): a token present only in a just-`add()`-ed, **un-optimized** row was returned by `fullTextSearch` — **1 hit, no optimize**. FTS index build on 30k = **60ms**; `optimize()` after +1 row = **36ms**, after +1000 rows = **91ms**.
- Official doc confirms: *"New data added after creating the FTS index will appear in search results while the incremental index is still in progress, but with increased latency due to a flat search on the unindexed portion. To avoid this, set fast_search=True to search only indexed data."* [^fts]
- Conclusion: the readiness gate's premise — `numUnindexedTextRows > 0 ⇒ not searchable ⇒ 503` (`searchReadiness.ts:191`) — is **false**. Unindexed rows are served (complete, slightly slower). The 503s were a self-inflicted false alarm.

### E4 — `optimize()` is incremental and cheap, not a whole-table rebuild
- Official doc: `optimize()` performs compaction (merge small fragments) + prune (drop versions older than 7d) + **incremental index update** (add newly-ingested data to existing indexes). Best practice: batch inserts; keep fragments < 100 (more for >500M rows). [^opt][^reindex]
- Measured: 36–91ms on a 30k FTS table (E3). (Cost WITH a vector index at scale — pending E7.)

### E5 — embed latency (the only real floor on the semantic frontier)
- Measured (synthetic nomic): **1 message = 342–484ms**; 100 in one batch = 5,687ms (**57ms/msg amortized**).
- Conclusion: a new message is semantically searchable in ~400ms **if embedded on ingest**. The 30-min delay was the poll tick (a stopgap), not the embed. Target: embed-on-ingest ⇒ semantic frontier ≈ embed round-trip (~400ms). Lexical frontier ≈ 0 (E3).

### E6 — IVF_PQ index parameters (documented defaults)
- Official doc: `num_partitions = num_rows // 4096`; `num_sub_vectors = dim // 8` (= 96 for nomic-768); choose `metric` to match the embedding. [^vec]
- Current code uses `ivfFlat(numPartitions:1)` = a brute-force flat scan — not the documented ANN config. Fix gated by E7.

### E7 — 1M-row scale benchmark at documented params  *(DONE)*
At `num_partitions=244` (=1M//4096), `num_sub_vectors=96` (=768//8), `cosine`:
| op | result |
|---|---|
| INGEST (bulk `add`, 10k batches) | 1M rows in **21.1s** (47,303 rows/s) |
| IVF_PQ build | 122.8s (one-time; `optimize()` updates incrementally after) |
| FTS build | 2.8s |
| BTREE(sessionId) build | 0.1s |
| vector query (IVF_PQ) | p50 **10ms** / p90 60ms |
| FTS query | p50 **53ms** / p90 92ms |
| sessionId read (BTREE) | p50 **11ms** / p90 27ms (vs E2's growing O(table) read) |
| `optimize()` on 1M rows | 14.9s |
| disk | 6.2 GB / 1M rows |
- Conclusion: the documented config scales to millions on a single embedded node with sub-100ms queries. Validates C2 (IVF_PQ), C3 (BTREE), C4 (bulk-add). Watch-item: IVF_PQ *build* is ~123s/1M (incremental after; GPU option exists [^gpu]).
- Disk scales ~linearly (6.2GB/1M) → object storage (S3) at tens-of-millions+ per [^storage].

[^gpu]: https://lancedb.com/documentation/guides/indexing/gpu-indexing/
[^storage]: https://docs.lancedb.com/storage

### E8 — vector index recall (REAL embeddings, the C2 decision)  *(DONE)*
Methodology iterations (each caught a real flaw before it shipped):
- random 768-d vectors → recall 31–39% — **invalid**: random high-dim vectors are near-equidistant (no NN structure for any ANN to recover). Discarded.
- real nomic vectors, no refine → IVF_PQ 77% / IVF_FLAT 85% — floor numbers; `nprobes` was a no-op (default 20 ≥ partitions) and `refineFactor` unused.
- real nomic vectors (100k, above the 65,536 PQ-training floor the KMeans warning names), proper query params:

| config | recall@10 | p50 |
|---|---|---|
| ivfPq nprobe=20, refine=none | 67% | 7.4ms |
| **ivfPq nprobe=20, refine=10** | **97%** | 9.4ms |
| **ivfPq nprobe=40, refine=25** | **98%** | 9.7ms |
| ivfFlat nprobe=20 / 40 (lossless) | 81% | 12–14ms |

- Decision: **C2 = IVF_PQ (numPartitions=rows//4096, numSubVectors=dim//8) + query-time `nprobes` + `refineFactor`** above the PQ floor; below 65,536 rows keep `ivfFlat(numPartitions:1)` (brute is sub-10ms at that scale and PQ can't train). `refineFactor` reranks `limit×factor` candidates with full-precision vectors, recovering PQ loss to ~98% recall@10 at ~10ms vs brute-scan's ~seconds at 1M. [^vec][^refine] (recall@10 is tie/duplicate-confounded in this corpus, so ~98% ≈ the practical exact ceiling; the grep end-to-end gate is the final quality arbiter.)
- ! `quasar-dev` CLI search is broken (`Failed to parse JSON`) — the server endpoint works (curl-verified). CLI fix is part of the planned CLI rewrite.

[^refine]: https://lancedb.github.io/lancedb/js/classes/VectorQuery/ (refineFactor: fetch limit×factor, rerank with full vectors)

## Scale ceiling (honest, doc-grounded)
- LanceDB OSS (embedded, what we run) *"comfortably handles **millions** of vectors on a single node."* **Billions = Enterprise/distributed** (distributed indexing, RaBitQ, HNSW centroid routing; p99 21ms @ 10B). [^faq][^10b]
- Therefore: the MacBook near-term (~1M rows) is dead-center the safe zone. Tens of millions: safe with IVF_PQ + object storage. Hundreds of millions: edge (docs: >500M needs more fragments). Genuine billions on a single embedded node is **outside the OSS envelope** — a distributed/Enterprise decision, not a config tweak.

## Root cause (corrected, evidence-ranked)
Every "hours" / 503 / "kills the system" symptom was self-inflicted, not LanceDB:
1. The 503s = the readiness gate firing on `numUnindexedRows > 0`, a premise E3 falsifies. (The gate itself was a sound "rather crash than serve garbage" guardrail; its *trigger* was wrong.)
2. The original "glacial" re-index = per-session `optimize()` (×4,000) — since removed; then the embed clobber re-queued ~305k jobs; on a brute-scan index (E6).
3. The per-session `sessionId` read is O(table) (E2) — a real but unindexed-only quadratic.
4. `mergeInsert` was never the cause (E1).

## Change plan (each gated by its evidence)
- C1 — relax the readiness gate: 503 only on hard error / no-index; serve with an unindexed tail (E3, [^fts]). Preserves "never garbage" (garbage sources fixed: 224/clobber/handle); kills false-alarm 503s.
- C2 — vector index → IVF_PQ at documented params (E6, E7, [^vec]).
- C3 — BTREE scalar index on `sessionId` (E2, [^scalar]).
- C4 — bulk-`add()` ingest path for rebuilds; `mergeInsert` only for incremental updates (E1, [^opt]).
- C5 — embed-on-ingest (event-driven), retire the poll tick (E5).
- C6 — `optimize()` scheduled/idle, fragments < 100 (E4, [^opt]).

[^fts]: https://docs.lancedb.com/indexing/fts-index
[^reindex]: https://docs.lancedb.com/indexing/reindexing
[^vec]: https://docs.lancedb.com/indexing/vector-index
[^scalar]: https://lancedb.com/docs/indexing/scalar-index/
[^opt]: https://lancedb.com/documentation/concepts/data.html
[^faq]: https://docs.lancedb.com/faq/faq-oss
[^10b]: https://www.lancedb.com/blog/how-lancedb-accelerates-vector-search-at-10-billion-scale
