/**
 * Second-opinion review of the scale-hardening change set (C1+C2+C3) by grok,
 * opencode, and antigravity (agy). Each reads the diff + evidence ledger and
 * looks for real bugs, invariant risks, and scale concerns. claude synthesizes.
 *
 *   bun /Users/guilhermecastro/Projects/prism/src/cli.ts workflow run \
 *     workflows/quasar-hardening-review.workflow.ts --worker grok \
 *     --permission permissive --max-concurrent-tasks 4 --task-timeout-ms 900000 --detach
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const BRIEF = `Review a scale-hardening change set for QUASAR (local cross-harness AI-session search; SQLite truth + LanceDB FTS/vector; Effect-first TypeScript). Three commits on main since ea42543:
- C1 (daa0997): readiness gate (packages/server/src/searchReadiness.ts) now SERVES a catching-up index instead of returning 503; it fails closed ONLY on a hard LanceDB error or a genuinely missing index. Rationale: LanceDB FTS+vector both include newly-added, un-optimized rows (measured), so an unindexed tail yields complete-or-current results, never wrong ones. The owner's hard invariant is "rather crash than serve GARBAGE" (wrong results) — incomplete-but-correct (e.g. newest rows pending embed, absent from semantic) is acceptable and disclosed.
- C2 (99792f5): vector index (packages/server/src/lancedb.ts) is now adaptive — IVF_PQ (numPartitions=rows//4096, numSubVectors=dim//8) at/above 65536 rows, else brute ivfFlat; queries apply nprobes=40 + refineFactor=25 (measured recall@10=98% @ ~10ms vs brute O(N)).
- C3 (bdbd5b7): BTREE scalar index on sessionId so per-session deleteOrphans/no-clobber reads are not O(table).

Inspect the actual diff and code: run \`git -C /Users/guilhermecastro/Projects/quasar diff ea42543..HEAD -- packages/server/src\` and read packages/server/src/{searchReadiness,lancedb}.ts and docs/architecture/quasar-scale-engineering.md (the evidence ledger E1-E9).

Find, with evidence (file:line):
1) REAL bugs (correctness, Effect misuse, edge cases) — not style.
2) INVARIANT risks: any path where the relaxed gate could now serve GARBAGE (wrong results, not merely incomplete). This is the owner's hard line.
3) SCALE concerns: IVF_PQ/nprobe behavior at 1M and 10M (nprobes=40 of ~244 partitions at 1M = ~16% probed — is recall at risk? does refineFactor compensate?); the IVF_PQ build cost; the migration of existing indexes.
Be adversarial and concrete. Return ONLY the schema.`;

const Review = Schema.Struct({
  worker: Schema.String,
  verdict: Schema.String,
  realBugs: Schema.Array(Schema.Struct({ where: Schema.String, issue: Schema.String, severity: Schema.String })),
  invariantRisks: Schema.Array(Schema.String),
  scaleConcerns: Schema.Array(Schema.String),
  nits: Schema.optional(Schema.Array(Schema.String)),
});

const reviewTask = (id: string, worker: "grok" | "opencode" | "antigravity-cli", model: string) =>
  defineTask({
    id,
    agent: agents.forge.explorer,
    worker: { worker, model },
    output: Review,
    cacheKey: `hardening-review/${id}/v1`,
    prompt: `${BRIEF}\n\nYou are reviewer ${id}. Return ONLY JSON: { worker, verdict, realBugs[{where,issue,severity}], invariantRisks[], scaleConcerns[], nits?[] }.`,
  });

export default defineWorkflow({
  name: "quasar-hardening-review",
  run: (wf) =>
    Effect.gen(function* () {
      const safe = (t: ReturnType<typeof reviewTask>) => wf.runTask(t).pipe(Effect.catchAll(() => Effect.succeed(null)));
      const [grok, opencode, agy] = yield* Effect.all(
        [
          safe(reviewTask("grok", "grok", "grok-build")),
          safe(reviewTask("opencode", "opencode", "synthetic/hf:moonshotai/Kimi-K2.6")),
          safe(reviewTask("antigravity", "antigravity-cli", "gpt-5.4-mini")),
        ],
        { concurrency: "unbounded" },
      );
      return { grok, opencode, agy };
    }),
});
