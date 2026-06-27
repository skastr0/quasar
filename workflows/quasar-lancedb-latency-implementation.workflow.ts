/**
 * Side-effecting implementation workflow for Quasar LanceDB latency fixes.
 *
 * Run:
 *   git add workflows/quasar-lancedb-latency-implementation.workflow.ts
 *   prism workflow validate workflows/quasar-lancedb-latency-implementation.workflow.ts
 *   prism workflow run workflows/quasar-lancedb-latency-implementation.workflow.ts --worker codex-cli --model gpt-5.4-mini --max-concurrent-tasks 4 --task-timeout-ms 1200000 --no-cache --detach
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const MEASURED_CONTEXT = `Measured live Mac mini profile:
- route profile: 60/60 HTTP 200, 2026-06-25T19:46:36Z -> 19:50:24Z.
- semantic.conc4: total p50/p95/max 22.936s/31.793s/31.793s; readiness 229ms/610ms/610ms; embed 1ms/2ms/2ms; LanceDB search 22.706s/31.552s/31.552s; residual p95 1ms.
- fusion.conc4: total p50/p95/max 22.536s/31.866s/31.866s; readiness 243ms/567ms/567ms; embed 0ms/13ms/13ms; LanceDB search 22.313s/31.641s/31.641s; residual p95 6ms.
- lexical.conc4: total p50/p95/max 406ms/2.651s/2.651s; readiness 180ms/400ms/400ms; LanceDB FTS 226ms/2.417s/2.417s.
- direct LanceDB probe after route run: connect 25ms; openTable 15ms; query build 0-1ms; fresh embedding API 352-971ms; vector toArray 690-1772ms; hybrid toArray 882-1744ms; FTS toArray 545-1746ms.
- same route window had 98 Lance KMeans warnings.

Official-doc constraints from the council:
- LanceDB OSS indexes are manual; index_stats num_unindexed_rows==0 and wait_for_index are documented completion checks.
- optimize() covers compaction, prune, and adding new data to existing indices.
- scalar indexes accelerate filters in vector and non-vector searches; BTREE is for high-cardinality strings/numerics, BITMAP for low-cardinality fields.
- VectorQuery.select projection affects latency; refineFactor fetches limit*refineFactor full vectors and impacts latency.
- Outdated indexes combine indexed results with exhaustive search on new data, preserving coverage while increasing latency.`;

const GLOBAL_CONTRACT = `Operate inside /Users/guilhermecastro/Projects/quasar.
Read AGENTS.md before editing.
Do not SSH anywhere; this is the Mac mini.
Do not print secrets or .env values.
Do not use Tower/glyph identifiers in source code, tests, fixtures, schemas, runtime fields, file paths, or public contracts.
Do not blame SQLite, corpus size, or LanceDB as a class. Fix Quasar-side mistakes first.
No "likely/probably/possibly/seems/maybe" in claims. Use measured evidence or mark unverified.
The workflow is the implementer. The orchestrator outside the workflow is not implementing these changes.
Existing dirty files are ambient input, not accepted work. Inspect them, then own, rewrite, or leave them explicitly. Do not revert unrelated user work.`;

const GLYPHS = [
  {
    id: "g1-observability",
    title: "Search benchmark and index-state receipts",
    objective: "Add or repair a reusable benchmark/status surface that records per-stage latency, LanceDB index stats, vector table stats, queue/load context, and raw timestamps so every latency claim has a receipt.",
    acceptance: [
      "A command or script can run lexical, semantic, and fusion batteries with concurrency levels and emit JSON or JSONL receipts.",
      "Receipts include wall-clock start/end timestamps, per-request total/readiness/embed/search/residual timing, status code, mode, and query label.",
      "Receipts include LanceDB table/index state before and after where available: row counts, index names, indexed/unindexed rows, and active vector table name.",
      "The implementation does not read or print session message content beyond query/result snippets already returned by search tests.",
      "Focused tests or documented smoke commands prove the harness runs.",
    ],
    files: ["scripts", "packages/server/src/server.ts", "packages/server/src/searchReadiness.ts", "packages/server/test"],
    reviewers: ["requirementsTracer", "verificationReviewer", "performanceReviewer", "simplicityReviewer"],
  },
  {
    id: "g2-vector-readiness",
    title: "Semantic/fusion readiness proves vector index completion",
    objective: "Change request-time readiness so semantic and fusion do not enter expensive vector/hybrid scans unless the active vector table and vector index are complete by LanceDB index stats.",
    acceptance: [
      "Lexical readiness remains cheap and does not call heavyweight tableStats on hot request paths.",
      "Semantic/fusion readiness checks the active embedding profile table, vector index existence, and numUnindexedRows === 0.",
      "Pending/leased embed jobs are surfaced in readiness stats.",
      "Tests cover empty corpus, table missing, lexical stale-tail serving, semantic blocked by missing vector index, semantic blocked by unindexed vector rows, and semantic ready after vector index completion.",
      "The response body exposes enough stats to explain a 503 without exposing secrets or message content.",
    ],
    files: ["packages/server/src/searchReadiness.ts", "packages/server/src/lancedb.ts", "packages/server/test/searchReadiness.test.ts"],
    reviewers: ["requirementsTracer", "verificationReviewer", "reliabilityReviewer", "contractReviewer"],
  },
  {
    id: "g3-filter-scalar-indexes",
    title: "Scalar indexes for search filters",
    objective: "Create the scalar indexes needed by Quasar's actual filters so metadata filtering does not become an avoidable search-path tax.",
    acceptance: [
      "Index creation covers existing hot filter columns used by routes/read paths: sessionId, projectKey, provider, role, and contentHash unless source inspection proves a column is not used.",
      "Index types are chosen from LanceDB docs and justified per column cardinality where the choice matters.",
      "Replacement/drop logic handles all managed indexes without deleting unrelated indexes.",
      "Tests assert expected index names for lexical-only and vector-capable tables.",
      "Existing delete/read behavior by session remains covered.",
    ],
    files: ["packages/server/src/lancedb.ts", "packages/server/test/lancedb.test.ts"],
    reviewers: ["requirementsTracer", "verificationReviewer", "performanceReviewer", "contractReviewer"],
  },
  {
    id: "g4-hybrid-projection",
    title: "Hybrid query projection before materialization",
    objective: "Ensure hybrid search pushes projection into the LanceDB query before toArray, matching vector/FTS paths and LanceDB projection guidance.",
    acceptance: [
      "hybridSearch applies select/selectOrDefault before toArray.",
      "A focused test or benchmark proves hybrid requests can request a narrow projection and still rank/return expected fields.",
      "No search route starts relying on full-row materialization when it only needs projected fields.",
      "No behavioral regression to lexical/vector results.",
    ],
    files: ["packages/server/src/lancedb.ts", "packages/server/test/lancedb.test.ts", "packages/server/src/search.ts"],
    reviewers: ["requirementsTracer", "verificationReviewer", "performanceReviewer", "simplicityReviewer"],
  },
  {
    id: "g5-maintenance-optimize",
    title: "Maintenance index refresh path",
    objective: "Align maintenance with LanceDB optimize/index-refresh docs unless source tests or measurements prove Quasar needs a narrower direct-GC exception.",
    acceptance: [
      "Maintenance ownership is explicit: when to call optimize, when to create indexes, and when any direct _indices cleanup is allowed.",
      "If direct _indices cleanup remains, tests prove why optimize alone is insufficient for the current JS/OSS behavior.",
      "No request path performs heavy maintenance.",
      "Tests cover maintenance preserving searchability and bounding stale index artifacts.",
      "Operator-facing status distinguishes queue/embedding work from LanceDB maintenance/index work.",
    ],
    files: ["packages/server/src/maintenance.ts", "packages/server/src/lancedb.ts", "packages/server/test/lancedb.test.ts", "packages/server/test/searchReadiness.test.ts"],
    reviewers: ["requirementsTracer", "verificationReviewer", "reliabilityReviewer", "consolidationReviewer"],
  },
  {
    id: "g6-tune-and-govern",
    title: "Measured tuning and search concurrency governance",
    objective: "After g1-g5, run a measured sweep and implement only the knobs that reduce semantic/fusion latency without hiding correctness or overloading the server.",
    acceptance: [
      "Runs the benchmark battery after prior glyphs and records before/after receipts.",
      "Sweeps nprobes/refineFactor/concurrency or proves why a knob cannot be varied with the current code.",
      "Any chosen default or config has measured recall/latency evidence against an exhaustive or documented baseline.",
      "If request concurrency needs a governor, it is explicit, bounded, tested, and visible in metrics/status.",
      "Final validation includes focused tests plus the broadest feasible test command, with failures classified as blocking or unrelated by evidence.",
    ],
    files: ["packages/server/src/lancedb.ts", "packages/server/src/server.ts", "packages/server/src/config.ts", "scripts", "packages/server/test"],
    reviewers: ["requirementsTracer", "verificationReviewer", "performanceReviewer", "reliabilityReviewer"],
  },
] as const;

const GLYPH_RUN_ORDER = [
  "g5-maintenance-optimize",
  "g2-vector-readiness",
  "g3-filter-scalar-indexes",
  "g4-hybrid-projection",
  "g1-observability",
  "g6-tune-and-govern",
] as const;

const orderedGlyphs = GLYPH_RUN_ORDER.map((id) => {
  const glyph = GLYPHS.find((candidate) => candidate.id === id);
  if (glyph === undefined) throw new Error(`Missing glyph definition: ${id}`);
  return glyph;
});

const reviewerAgent = (name: (typeof GLYPHS)[number]["reviewers"][number]) => {
  switch (name) {
    case "requirementsTracer": return agents.forge.requirementsTracer;
    case "verificationReviewer": return agents.forge.verificationReviewer;
    case "performanceReviewer": return agents.forge.performanceReviewer;
    case "reliabilityReviewer": return agents.forge.reliabilityReviewer;
    case "contractReviewer": return agents.forge.contractReviewer;
    case "simplicityReviewer": return agents.forge.simplicityReviewer;
    case "consolidationReviewer": return agents.forge.consolidationReviewer;
  }
};

const ValidationRun = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  result: Schema.Literal("passed", "failed", "skipped"),
  evidence: Schema.String,
});

const BaselineAudit = Schema.Struct({
  status: Schema.Literal("ready", "blocked"),
  dirtyFiles: Schema.Array(Schema.String),
  targetDirtyFiles: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.String),
  instructionsForBuilders: Schema.Array(Schema.String),
});

const BuildReport = Schema.Struct({
  glyphId: Schema.String,
  status: Schema.Literal("built", "blocked"),
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String),
  validation: Schema.Array(ValidationRun),
  measurements: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.String),
});

const QaReport = Schema.Struct({
  glyphId: Schema.String,
  verdict: Schema.Literal("pass", "fail", "blocked"),
  validation: Schema.Array(ValidationRun),
  failures: Schema.Array(Schema.String),
});

const ReviewReport = Schema.Struct({
  glyphId: Schema.String,
  reviewer: Schema.String,
  verdict: Schema.Literal("pass", "needs-work", "blocked"),
  blockingFindings: Schema.Array(Schema.String),
  nonBlockingFindings: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
});

const GlyphDecision = Schema.Struct({
  glyphId: Schema.String,
  decision: Schema.Literal("continue", "repair", "blocked"),
  summary: Schema.String,
  nextAction: Schema.String,
  evidence: Schema.Array(Schema.String),
});

const FinalReport = Schema.Struct({
  verdict: Schema.Literal("ship", "needs-work", "blocked"),
  glyphsCompleted: Schema.Array(Schema.String),
  remainingWork: Schema.Array(Schema.String),
  testEvidence: Schema.Array(ValidationRun),
  benchmarkEvidence: Schema.Array(Schema.String),
  deploymentNeeded: Schema.Boolean,
  notes: Schema.Array(Schema.String),
});

const worker = { worker: "codex-cli", model: "gpt-5.4-mini" } as const;
const reviewerWorker = { worker: "codex-cli", model: "gpt-5.4-mini" } as const;

const mustAuditReady = {
  name: "baseline-ready",
  check: ({ output }: { output: typeof BaselineAudit.Type }) => output.status === "ready"
    ? Effect.void
    : Effect.fail(new Error(`baseline blocked: ${output.notes.join("; ")}`)),
  repairPrompt: () => "Return blocked only for a real safety blocker. Existing dirty files are allowed as ambient input if builders can inspect and avoid unrelated reverts.",
};

const mustBuild = (glyphId: string) => ({
  name: `${glyphId}-built`,
  check: ({ output }: { output: typeof BuildReport.Type }) => output.status === "built"
    ? Effect.void
    : Effect.fail(new Error(`build blocked: ${output.blockers.join("; ")}`)),
  repairPrompt: () => "Continue implementation for this glyph. Return blocked only with a concrete source-grounded blocker.",
});

const mustQaPass = (glyphId: string) => ({
  name: `${glyphId}-qa-pass`,
  check: ({ output }: { output: typeof QaReport.Type }) => output.verdict === "pass"
    ? Effect.void
    : Effect.fail(new Error(`QA did not pass: ${output.failures.join("; ")}`)),
  repairPrompt: () => "Run the relevant validation again. Return pass only with command evidence and exit code 0.",
});

const mustReviewDecide = (glyphId: string, reviewer: string) => ({
  name: `${glyphId}-${reviewer}-review-decide`,
  check: ({ output }: { output: typeof ReviewReport.Type }) => output.verdict !== "blocked"
    ? Effect.void
    : Effect.fail(new Error(`review blocked: ${output.blockingFindings.join("; ")}`)),
  repairPrompt: () => "Re-open the diff and files, then return pass or needs-work with concrete evidence.",
});

const buildPrompt = (
  glyph: (typeof GLYPHS)[number],
  baseline: typeof BaselineAudit.Type,
  prior?: { readonly decision: typeof GlyphDecision.Type; readonly build: typeof BuildReport.Type; readonly qa: typeof QaReport.Type; readonly reviews: readonly typeof ReviewReport.Type[] },
) => `Forge build phase. Implement exactly this glyph through code/tests/scripts. You may edit files and run commands.

${GLOBAL_CONTRACT}

${MEASURED_CONTEXT}

Glyph:
${JSON.stringify(glyph, null, 2)}

Baseline audit:
${JSON.stringify(baseline, null, 2)}

${prior === undefined ? "" : `Previous attempt and review findings:\n${JSON.stringify(prior, null, 2)}\n`}

Rules:
- Read the listed files and adjacent tests before editing.
- Baseline findings are evidence and ordering pressure, not permission to implement another glyph.
- Edit only files needed for the current glyph. If an unrelated dirty change breaks validation, report blocked instead of absorbing it.
- Treat existing ambient diffs as untrusted. If you keep any part, you own it and validate it.
- Do not commit. Leave a working-tree diff and return exact filesChanged.
- Add or update focused tests for the glyph.
- Run the smallest focused validation that proves the glyph. Run broader validation if tractable.
- Return JSON only.`;

const qaPrompt = (glyph: (typeof GLYPHS)[number], build: typeof BuildReport.Type) => `Forge verification phase. Do not edit files.

${GLOBAL_CONTRACT}

Glyph:
${JSON.stringify(glyph, null, 2)}

Build report:
${JSON.stringify(build, null, 2)}

Run focused validation for this glyph. Also inspect git diff for accidental scope creep and secret leakage.
Return JSON only with command evidence and exit codes.`;

const reviewPrompt = (glyph: (typeof GLYPHS)[number], build: typeof BuildReport.Type, qa: typeof QaReport.Type, reviewer: string) => `Forge review phase. Do not edit files.

${GLOBAL_CONTRACT}

Reviewer lens: ${reviewer}
Glyph:
${JSON.stringify(glyph, null, 2)}

Build:
${JSON.stringify(build, null, 2)}

QA:
${JSON.stringify(qa, null, 2)}

Review the actual diff and source files. Findings first. Return JSON only.`;

const runGlyph = (
  wf: Parameters<Parameters<typeof defineWorkflow>[0]["run"]>[0],
  glyph: (typeof GLYPHS)[number],
  baseline: typeof BaselineAudit.Type,
) =>
  Effect.gen(function* () {
    const build = yield* wf.runTask(defineTask({
      id: `${glyph.id}-build`,
      agent: agents.forge.builder,
      worker,
      output: BuildReport,
      cacheKey: `quasar-lancedb-latency-implementation/${glyph.id}/build/v2`,
      finish: { maxRepairs: 1, criteria: [mustBuild(glyph.id)] },
      prompt: buildPrompt(glyph, baseline),
    }));

    const qa = yield* wf.runTask(defineTask({
      id: `${glyph.id}-qa`,
      agent: agents.forge.verificationReviewer,
      worker: reviewerWorker,
      output: QaReport,
      cacheKey: `quasar-lancedb-latency-implementation/${glyph.id}/qa/v2`,
      finish: { maxRepairs: 1, criteria: [mustQaPass(glyph.id)] },
      prompt: qaPrompt(glyph, build),
    }));

    const settledReviews = yield* Effect.all(
      glyph.reviewers.map((reviewer) =>
        Effect.either(wf.runTask(defineTask({
          id: `${glyph.id}-review-${reviewer}`,
          agent: reviewerAgent(reviewer),
          worker: reviewerWorker,
          output: ReviewReport,
          cacheKey: `quasar-lancedb-latency-implementation/${glyph.id}/review/${reviewer}/v2`,
          finish: { maxRepairs: 1, criteria: [mustReviewDecide(glyph.id, reviewer)] },
          prompt: reviewPrompt(glyph, build, qa, reviewer),
        }))),
      ),
      { concurrency: "unbounded" },
    );
    const reviews = settledReviews.map((result, index) => result._tag === "Right"
      ? result.right
      : {
        glyphId: glyph.id,
        reviewer: glyph.reviewers[index],
        verdict: "blocked" as const,
        blockingFindings: [String(result.left)],
        nonBlockingFindings: [],
        evidence: [],
      });

    const decision = yield* wf.runTask(defineTask({
      id: `${glyph.id}-synthesis`,
      agent: agents.forge.orchestratorEngineer,
      worker: reviewerWorker,
      output: GlyphDecision,
      cacheKey: `quasar-lancedb-latency-implementation/${glyph.id}/synthesis/v2`,
      prompt: `Synthesize this glyph. Do not edit files.

${GLOBAL_CONTRACT}

Glyph:
${JSON.stringify(glyph, null, 2)}

Build:
${JSON.stringify(build, null, 2)}

QA:
${JSON.stringify(qa, null, 2)}

Reviews:
${JSON.stringify(reviews, null, 2)}

decision rules:
- continue only if QA passed and all reviews pass or have non-blocking findings only.
- repair if any review says needs-work.
- blocked if QA failed after repair budget or a reviewer is blocked.
Return JSON only.`,
    }));

    if (decision.decision !== "repair") {
      return { glyph, build, qa, reviews, decision };
    }

    const repairBuild = yield* wf.runTask(defineTask({
      id: `${glyph.id}-repair-build`,
      agent: agents.forge.builder,
      worker,
      output: BuildReport,
      cacheKey: `quasar-lancedb-latency-implementation/${glyph.id}/repair-build/v2`,
      finish: { maxRepairs: 1, criteria: [mustBuild(`${glyph.id}-repair`)] },
      prompt: buildPrompt(glyph, baseline, { decision, build, qa, reviews }),
    }));

    const repairQa = yield* wf.runTask(defineTask({
      id: `${glyph.id}-repair-qa`,
      agent: agents.forge.verificationReviewer,
      worker: reviewerWorker,
      output: QaReport,
      cacheKey: `quasar-lancedb-latency-implementation/${glyph.id}/repair-qa/v2`,
      finish: { maxRepairs: 1, criteria: [mustQaPass(`${glyph.id}-repair`)] },
      prompt: qaPrompt(glyph, repairBuild),
    }));

    const repairReviews = yield* Effect.all(
      glyph.reviewers.map((reviewer) => wf.runTask(defineTask({
        id: `${glyph.id}-repair-review-${reviewer}`,
        agent: reviewerAgent(reviewer),
        worker: reviewerWorker,
        output: ReviewReport,
        cacheKey: `quasar-lancedb-latency-implementation/${glyph.id}/repair-review/${reviewer}/v2`,
        finish: { maxRepairs: 1, criteria: [mustReviewDecide(`${glyph.id}-repair`, reviewer)] },
        prompt: reviewPrompt(glyph, repairBuild, repairQa, reviewer),
      }))),
      { concurrency: "unbounded" },
    );

    const repairDecision = yield* wf.runTask(defineTask({
      id: `${glyph.id}-repair-synthesis`,
      agent: agents.forge.orchestratorEngineer,
      worker: reviewerWorker,
      output: GlyphDecision,
      cacheKey: `quasar-lancedb-latency-implementation/${glyph.id}/repair-synthesis/v2`,
      prompt: `Synthesize repaired glyph. Do not edit files.

${GLOBAL_CONTRACT}

Glyph:
${JSON.stringify(glyph, null, 2)}
Build:
${JSON.stringify(repairBuild, null, 2)}
QA:
${JSON.stringify(repairQa, null, 2)}
Reviews:
${JSON.stringify(repairReviews, null, 2)}

Return JSON only. continue only if QA passed and reviews cleared blockers.`,
    }));

    return { glyph, build: repairBuild, qa: repairQa, reviews: repairReviews, decision: repairDecision };
  });

export default defineWorkflow({
  name: "quasar-lancedb-latency-implementation",
  run: (wf) =>
    Effect.gen(function* () {
      const baseline = yield* wf.runTask(defineTask({
        id: "baseline-audit",
        agent: agents.forge.codebaseArcheologist,
        worker: reviewerWorker,
        output: BaselineAudit,
        cacheKey: "quasar-lancedb-latency-implementation/baseline/v2",
        finish: { maxRepairs: 1, criteria: [mustAuditReady] },
        prompt: `Audit the repo before implementation. Do not edit files.

${GLOBAL_CONTRACT}

Run git status --short, inspect the target files named by all glyphs, and produce builder instructions for how to handle ambient dirty files.
Return ready unless the dirty tree makes safe implementation impossible.`,
      }));

      const results = [];
      for (const glyph of orderedGlyphs) {
        const result = yield* runGlyph(wf, glyph, baseline);
        results.push(result);
        if (result.decision.decision !== "continue") {
          return yield* wf.runTask(defineTask({
            id: "final-blocked-report",
            agent: agents.forge.orchestratorEngineer,
            worker: reviewerWorker,
            output: FinalReport,
            cacheKey: "quasar-lancedb-latency-implementation/final-blocked/v2",
            prompt: `Produce the workflow stop report. Do not edit files.

${GLOBAL_CONTRACT}

Completed/blocked results:
${JSON.stringify(results, null, 2)}

Return JSON only.`,
          }));
        }
      }

      return yield* wf.runTask(defineTask({
        id: "final-validation-and-benchmark",
        agent: agents.forge.verificationReviewer,
        worker: reviewerWorker,
        output: FinalReport,
        cacheKey: "quasar-lancedb-latency-implementation/final-validation/v2",
        prompt: `Run final validation and benchmark battery. Do not edit files unless a generated benchmark output file is explicitly part of the harness.

${GLOBAL_CONTRACT}

Glyph results:
${JSON.stringify(results, null, 2)}

Run focused tests, the broadest feasible test command, and the search benchmark/status battery created by g1. Include exact commands, exit codes, and benchmark receipt paths or compact metrics.
Return JSON only.`,
      }));
    }),
});
