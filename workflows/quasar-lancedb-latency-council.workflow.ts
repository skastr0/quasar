/**
 * Read-only Prism council for Quasar LanceDB latency.
 *
 * Run:
 *   git add workflows/quasar-lancedb-latency-council.workflow.ts
 *   prism workflow validate workflows/quasar-lancedb-latency-council.workflow.ts
 *   prism workflow run workflows/quasar-lancedb-latency-council.workflow.ts --permission sandbox-read-only --max-concurrent-tasks 4 --task-timeout-ms 900000 --detach
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const MEASURED = `Measured Quasar latency evidence, all from live Mac mini route profiler:
- exact route run: 60/60 HTTP 200, 2026-06-25T19:46:36Z -> 19:50:24Z
- semantic.conc4: total p50/p95/max 22.936s/31.793s/31.793s; readiness p50/p95/max 229ms/610ms/610ms; embed p50/p95/max 1ms/2ms/2ms; LanceDB search p50/p95/max 22.706s/31.552s/31.552s; residual p95 1ms
- fusion.conc4: total p50/p95/max 22.536s/31.866s/31.866s; readiness p50/p95/max 243ms/567ms/567ms; embed p50/p95/max 0ms/13ms/13ms; LanceDB search p50/p95/max 22.313s/31.641s/31.641s; residual p95 6ms
- lexical.conc4: total p50/p95/max 406ms/2.651s/2.651s; readiness p50/p95/max 180ms/400ms/400ms; LanceDB FTS p50/p95/max 226ms/2.417s/2.417s
- direct read-only LanceDB probe after route run: connect 25ms; openTable 15ms; query construction 0-1ms; fresh embedding API 352-971ms; vector toArray 690-1772ms; hybrid toArray 882-1744ms; FTS toArray 545-1746ms
- same route window had 98 Lance kmeans warnings: "KMeans: more than 10% of clusters are empty".

Relevant Quasar source:
- packages/server/src/server.ts search routes measure readiness/embed/search stages.
- packages/server/src/embeddings.ts embedText checks embedding_cache before remote embed.
- packages/server/src/lancedb.ts vectorSearch uses vectorSearch(...).nprobes(40).refineFactor(50).limit(...).select(...).where(...).toArray().
- packages/server/src/lancedb.ts hybridSearch uses nearestTo(...).nprobes(40).refineFactor(50).fullTextSearch(...).rerank(RRFReranker).limit(...).where(...).toArray().
- packages/server/src/lancedb.ts createMessageIndexes controls FTS, scalar, vector index creation.
- packages/server/src/maintenance.ts controls optimization/index refresh cadence.

Operator constraint:
- Assume Quasar is making one or more mistakes until evidence falsifies that.
- Do not blame SQLite, corpus scale, or LanceDB as a technology category without proving Quasar-side mistakes are exhausted.
- Do not modify files. This is a read-only investigation council.`;

const OFFICIAL_DOCS = `Official LanceDB docs receipts to use as primary-source constraints:
- OSS vector indexes are manual: create/update/tune by calling create_index/createIndex; Enterprise auto-indexes in background. Vector index build can be async; wait_timeout/wait_for_index and index_stats(num_unindexed_rows==0) are how completion is checked. Source: https://docs.lancedb.com/indexing/vector-index lines 117-132.
- Reindexing docs: as data is added, outdated indexes combine existing index results with exhaustive/flat search on new data; this preserves coverage but can increase latency. optimize() performs compaction, cleanup/prune, and index update. fast_search can search only indexed data; index_stats reports unindexed rows. Source: https://docs.lancedb.com/indexing/reindexing lines 88-102.
- JS Table.optimize docs: optimize covers compaction, prune, and adding new data to existing indices; rule of thumb is optimize after 100,000+ records added/modified or more than 20 data modification operations. Source: https://lancedb.github.io/lancedb/js/classes/Table/ lines 539-552.
- FTS docs: create FTS indexes on text columns that are frequently searched; hybrid search has its own guide; complex queries can combine FTS with filters. Source: https://docs.lancedb.com/search/full-text-search lines 568-578.
- Hybrid docs: hybrid combines vector and full-text search with reranking; production hybrid queries should always set limit; explicit vector+text query is supported. Source: https://docs.lancedb.com/search/hybrid-search lines 101-105, 244-265, 323-328.
- JS VectorQuery docs: bypassVectorIndex performs exhaustive flat search and is useful as ground truth for recall/nprobes selection; distance metric must match the index metric; refineFactor only applies to IVF_PQ and fetches limit*refineFactor full vectors, which impacts latency; select only needed columns because projection affects latency. Source: https://lancedb.github.io/lancedb/js/classes/VectorQuery/ lines 214-220, 266-287, 585-629.
- JS Table docs: createIndex on vector columns speeds vector searches; scalar indexes speed filters in vector and non-vector searches; generated index name is column_idx. Source: https://lancedb.github.io/lancedb/js/classes/Table/ lines 326-334.
- Scalar index docs: scalar indexes accelerate metadata filtering; BTREE is best for high-cardinality strings/numerics, BITMAP for low-cardinality fields; wait_for_index/index_stats show fully indexed state. Source: https://docs.lancedb.com/indexing/scalar-index lines 101-132.
- IvfPqOptions docs: numSubVectors controls compression; efficient SIMD cases are 8 or 16 values per subvector; sampleRate controls kmeans training sample size and default is 256. Source: https://lancedb.github.io/lancedb/js/interfaces/IvfPqOptions/ lines 99-122.`;

const BASE_PROMPT = `${MEASURED}

${OFFICIAL_DOCS}

Return only JSON matching the schema. Every claim must include evidence: source file/line, command output, or official-doc URL+line range. Use "unverified" for anything you cannot prove. Do not use likely, probably, possibly, seems, maybe, or variants.`;

const Finding = Schema.Struct({
  claim: Schema.String,
  evidence: Schema.Array(Schema.String),
  confidence: Schema.Literal("proven", "unverified"),
});

const Recommendation = Schema.Struct({
  action: Schema.String,
  why: Schema.String,
  proofNeeded: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
});

const CouncilLens = Schema.Struct({
  lens: Schema.String,
  verdict: Schema.String,
  provenFindings: Schema.Array(Finding),
  quasarMistakes: Schema.Array(Finding),
  recommendedFixes: Schema.Array(Recommendation),
  escapeHatchAssessment: Schema.Struct({
    allowed: Schema.Boolean,
    reason: Schema.String,
    evidence: Schema.Array(Schema.String),
  }),
  nextMeasurements: Schema.Array(Schema.String),
});

const Synthesis = Schema.Struct({
  verdict: Schema.String,
  exactMistakesToInvestigateFirst: Schema.Array(Finding),
  rankedNextSteps: Schema.Array(Recommendation),
  escapeHatchStatus: Schema.Struct({
    status: Schema.Literal("rejected", "not-yet-allowed", "allowed"),
    evidence: Schema.Array(Schema.String),
  }),
  validationPlan: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
});

const explorer = agents.forge.explorer;

const lensTask = (
  id: string,
  worker: "codex-cli" | "grok" | "opencode" | "kimi-code" | "antigravity-cli",
  model: string,
  lens: string,
  prompt: string,
) =>
  defineTask({
    id,
    agent: explorer,
    worker: { worker, model },
    output: CouncilLens,
    cacheKey: `quasar-lancedb-latency-council/${id}/v1`,
    prompt: `${BASE_PROMPT}

Lens: ${lens}

${prompt}

Set lens="${lens}".`,
  });

export default defineWorkflow({
  name: "quasar-lancedb-latency-council",
  run: (wf) =>
    Effect.gen(function* () {
      const tasks = [
        lensTask(
          "docs-practice",
          "codex-cli",
          "gpt-5.4-mini",
          "official docs and API contract",
          "Cross-check Quasar's LanceDB usage against the official docs receipts and the installed JS API. Identify exact mismatches or confirmations. Prioritize optimize/index_stats/wait_for_index, scalar indexes for filters, projection width, refineFactor/nprobes, and hybrid query shape.",
        ),
        lensTask(
          "mistake-hunt",
          "codex-cli",
          "gpt-5.4-mini",
          "Quasar-side mistake hunt",
          "Assume Quasar is wrong. Read the relevant source and identify concrete mistakes that can explain the measured stage timings. Separate proven code facts from unverified hypotheses. Do not propose a technology replacement unless the Quasar mistakes are falsified.",
        ),
        lensTask(
          "fix-plan",
          "codex-cli",
          "gpt-5.4-mini",
          "fix and measurement plan",
          "Design the smallest fix sequence and exact validation battery. Include no blind tuning. Include how to isolate maintenance/index-build contention, query concurrency contention, index freshness, projection cost, filter-index use, and IVF_PQ recall/latency.",
        ),
        lensTask(
          "escape-hatch",
          "codex-cli",
          "gpt-5.4-mini",
          "technology escape hatch gate",
          "Argue against the escape hatch first. Only allow it if official docs and Quasar measurements prove LanceDB OSS cannot meet this workload after correct indexing, optimization, and concurrency control. If not allowed, state exactly what must be measured before revisiting.",
        ),
      ];

      const settled = yield* Effect.all(
        tasks.map((task) => Effect.either(wf.runTask(task))),
        { concurrency: "unbounded" },
      );
      const lenses = settled.map((result, index) => ({
        id: tasks[index].id,
        result: result._tag === "Right" ? result.right : null,
        error: result._tag === "Left" ? String(result.left) : null,
      }));

      return yield* wf.runTask(
        defineTask({
          id: "synthesis",
          agent: explorer,
          worker: { worker: "codex-cli", model: "gpt-5.4-mini" },
          output: Synthesis,
          cacheKey: "quasar-lancedb-latency-council/synthesis/v1",
          prompt: `${BASE_PROMPT}

Fuse these council lenses. Discard claims without evidence. Produce a ranked, evidence-first plan.

${JSON.stringify(lenses, null, 2)}`,
        }),
      );
    }),
});
