/**
 * Read-only multi-harness Prism council for Quasar storage/disk amplification.
 * Validates AGY's analysis + my live measurements, then designs the safe, sourced
 * remediation for each amplifier (LanceDB retention, queue-job retention, embedding
 * cache serialization, WAL, vector-row dedup). Read-only: design only, no edits.
 *
 * Run:
 *   git add workflows/quasar-disk-amplification-council.workflow.ts
 *   prism workflow validate workflows/quasar-disk-amplification-council.workflow.ts
 *   prism workflow run workflows/quasar-disk-amplification-council.workflow.ts --permission sandbox-read-only --max-concurrent-tasks 5 --task-timeout-ms 900000 --detach
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const MEASURED = `Quasar storage-amplification evidence — ALL verified live on the Mac mini just now (2026-06-27):
- Real product text across all provider histories: ~650 MB. Current server footprint: ~40 GB. The "infamous 42 GB" recreated.
- SQLite quasar.sqlite = 10.69 GB (PRAGMA page_count x page_size = 10,689,974,272) + quasar.sqlite-wal = 2.9 GB (uncheckpointed).
  - queue_jobs: 805,035 rows, ALL status='completed', NEVER deleted (COUNT(*) live). embed-message + index-session jobs accumulate forever.
  - embedding_cache: 298,676 rows; schema cols = [model TEXT, content_hash TEXT, dimensions INTEGER, text_bytes INTEGER, vector_json TEXT, created_at TEXT, updated_at TEXT]. 768-dim float vectors stored as JSON TEXT (~11.5KB/row ~= 3-4 GB; binary Float32 would be 768*4=3072 bytes/row ~= 915 MB).
- LanceDB search.lance = 29 GB and GROWING (was 7.1 GB after an aggressive reclaim ~2h ago -> regrew to 29 GB).
  - _indices generation dirs: 403 (vector table messages_c3ludGhldGljOmhmOm5vbWlj) + 307 (lexical table messages).
  - listVersions(): 226 (vector) + 188 (lexical) = 414 versions. (AGY's "17,035 versions" figure is stale/wrong; current is 414 — the bloat lives in _indices generation dirs + the sqlite tables, not 17k manifests.)
- CONTRIBUTING CAUSE just shipped by Claude (commit 3fcdbbb): maintenance.ts now calls optimize({ olderThanMs: VERSION_RETENTION_MS }) with VERSION_RETENTION_MS = 7 DAYS. Because optimize() runs every ~2 min and 7-day retention prunes nothing newer than 7 days, every generation accumulates for a week -> this is a primary driver of the live regrowth.
- Separately blocking semantic search (NOT a disk issue, but in scope): ~1,600 DUPLICATE vector rows + ~177 missing in the vector table (vectorRowCount 660,989 vs table 659,384) trip the fail-closed structural-divergence readiness gate, so semantic/fusion /search returns 503 even though the IVF_PQ index is present and fast (conc8 ~80ms).

Relevant Quasar source:
- packages/server/src/lancedb.ts: optimize() maps olderThanMs -> cleanupOlderThan; createMessageIndexes builds/keeps indexes (now never drops on a routine tick); upsertMessageRows uses mergeInsert(key).whenMatchedUpdateAll().whenNotMatchedInsertAll().
- packages/server/src/maintenance.ts: maintainTable() = ensure-missing + throttled optimize({ olderThanMs: 7d }); writer-idle gated.
- packages/server/src/services.ts: DurableQueue (queue_jobs); ack() sets status='completed' and never deletes; enqueue dedups by idempotencyKey.
- packages/server/src/embeddings.ts + store.ts: embedding_cache read/write (vector_json TEXT); store.ts owns the sqlite schema + migrations.
- packages/server/src/store.ts: index_divergence ledger; readiness gate consumes divergenceAggregate.

AGENTS.md binding principle (do NOT violate in any fix):
- "Never invent caps, clamps, gates, amplification ratios, or byte budgets ... Think in absolute megabytes, and measure real data before any shape decision." => remediation must prune by AGE/version/lifecycle and fix serialization, NOT invent a size cap or amplification ratio.

Operator constraints:
- Another agent is concurrently building a TUI for Quasar in this same repo. Do NOT design changes that touch TUI/CLI surfaces; stay server-side (packages/server). Flag any change that risks colliding with cli/ or a future tui/.
- The server is LIVE and continuously ingesting. Designs must be safe against a running writer (no data loss, no breaking in-flight queue jobs, no dropping a serving index).
- One canonical path; delete-don't-deprecate; make-illegal-states-unrepresentable; Effect + strong types where it fits.`;

const DOCS = `Primary-source receipts to ground against (cite URL + the specific claim):
- LanceDB reindexing/optimize: optimize() does compaction + prune/cleanup (cleanupOlderThan retention) + index update (folds new rows into existing indexes). https://docs.lancedb.com/indexing/reindexing
- LanceDB JS Table.optimize: cleanupOlderThan prunes versions/fragments older than the window; default retention 7 days; rule of thumb optimize after 100k+ records or 20+ modifications. https://lancedb.github.io/lancedb/js/classes/Table/
- SQLite WAL: wal_checkpoint(TRUNCATE) checkpoints and truncates the -wal file; PRAGMA wal_autocheckpoint controls cadence; VACUUM rewrites the db to reclaim free pages. https://www.sqlite.org/wal.html , https://www.sqlite.org/lang_vacuum.html
- SQLite BLOB vs TEXT for float vectors: a Float32Array buffer is 4 bytes/dim; JSON text of floats is ~3-5x larger and costs parse/stringify CPU per access.`;

const BASE = `${MEASURED}

${DOCS}

Return ONLY JSON matching the schema. Every claim carries evidence: a source file/line, a live measurement above, or an official-doc URL. Mark anything you cannot prove "unverified". Do not use likely/probably/possibly/seems/maybe. Design the SMALLEST correct, sourced fix; for each, give the experiment that proves it bounds disk / preserves data BEFORE it would ship.`;

const Finding = Schema.Struct({
  claim: Schema.String,
  evidence: Schema.Array(Schema.String),
  confidence: Schema.Literal("proven", "unverified"),
});

const Fix = Schema.Struct({
  item: Schema.String,
  change: Schema.String,
  files: Schema.Array(Schema.String),
  risk: Schema.Literal("low", "med", "high"),
  dataLossRisk: Schema.String,
  experiment: Schema.String,
  rollback: Schema.String,
  violatesAgentsMd: Schema.Boolean,
});

const CouncilLens = Schema.Struct({
  lens: Schema.String,
  verdict: Schema.String,
  validatedFindings: Schema.Array(Finding),
  refutedClaims: Schema.Array(Finding),
  fixes: Schema.Array(Fix),
  collisionRisksWithTui: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
});

const Synthesis = Schema.Struct({
  verdict: Schema.String,
  rankedFixes: Schema.Array(Fix),
  orderingRationale: Schema.String,
  experimentBattery: Schema.Array(Schema.String),
  safetyGate: Schema.Struct({
    safeToProceed: Schema.Array(Schema.String),
    needsMoreProof: Schema.Array(Schema.String),
  }),
  doNotTouch: Schema.Array(Schema.String),
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
    cacheKey: `quasar-disk-amplification-council/${id}/v1`,
    prompt: `${BASE}

Lens: ${lens}

${prompt}

Set lens="${lens}".`,
  });

export default defineWorkflow({
  name: "quasar-disk-amplification-council",
  run: (wf) =>
    Effect.gen(function* () {
      const tasks = [
        lensTask(
          "lance-retention",
          "grok",
          "grok-build",
          "LanceDB version/index retention + reclaim",
          "Validate that VERSION_RETENTION_MS=7d is the primary live regrowth driver. Design the correct optimize(cleanupOlderThan) retention window for a table optimized every ~2 min under continuous ingest — small enough to bound _indices generation dirs, large enough not to delete a version an in-flight reader/query needs. Specify the one-time reclaim to undo the current 29GB and the experiment that proves _indices/disk stays bounded over N optimize cycles. Cite LanceDB docs on cleanupOlderThan semantics + what a too-small window can break (concurrent readers).",
        ),
        lensTask(
          "embedding-cache-blob",
          "kimi-code",
          "kimi-code/kimi-for-coding",
          "embedding_cache JSON TEXT -> binary BLOB migration",
          "Design the safe migration of embedding_cache.vector_json TEXT (298,676 rows) to a binary Float32 BLOB. Cover: the store.ts schema migration (new column or table, backfill, drop old), the embeddings.ts read/write path, idempotency, zero-data-loss during a live-running server, and how to verify byte-for-byte vector equality post-migration. Quantify expected savings in absolute MB. State whether a one-shot backfill vs lazy re-cache is safer. The embeddings themselves dedup by content hash — confirm that holds.",
        ),
        lensTask(
          "queue-and-wal",
          "opencode",
          "synthetic/hf:moonshotai/Kimi-K2.6",
          "queue_jobs retention + SQLite WAL/VACUUM (adversarial re-check of AGY's analysis)",
          "Adversarially re-validate AGY's original amplification claims against the live numbers (805,035 completed jobs, 800,957 completed >24h, 0 active; 10.69GB sqlite; 2.9GB WAL). Design: (a) a safe completed-job retention prune (delete completed jobs older than a lifecycle window) that CANNOT delete a pending/leased/in-flight job and respects idempotency-key dedup; (b) a WAL checkpoint(TRUNCATE) cadence + whether a one-time VACUUM is needed and its lock/downtime cost on a 10GB live db. Correct any AGY number the live data refutes (the 17,035-versions figure is stale; actual is 414).",
        ),
        lensTask(
          "safety-and-dedup",
          "codex-cli",
          "gpt-5.4-mini",
          "correctness/safety review + vector-row dedup",
          "Two jobs. (1) Safety-review every other lens's proposed change for data-loss, correctness, and collision with a live-running server or the concurrent TUI agent; veto anything unsafe. (2) Design the dedup of the ~1,600 duplicate + 177 missing vector rows that trip the divergence gate and block semantic /search — root-cause whether it is the mergeInsert key, the embed-rekey gap, or both; design a fix that removes the dups, lets reconcile re-add clean, and makes the dup state unrepresentable going forward. Specify the experiment proving semantic /search returns 200 after.",
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
          cacheKey: "quasar-disk-amplification-council/synthesis/v2",
          prompt: `${BASE}

Fuse these council lenses into a ranked, evidence-first, SAFE remediation sequence. Discard unverified claims. Order fixes by (confidence x impact / risk). Mark each fix safeToProceed only if it is strongly sourced AND no lens vetoed it on safety. List doNotTouch (TUI/CLI surfaces, anything that risks the concurrent agent). Give the single experiment battery that proves the whole sequence bounds disk to absolute MB and loses zero data.

${JSON.stringify(lenses, null, 2)}`,
        }),
      );
    }),
});
