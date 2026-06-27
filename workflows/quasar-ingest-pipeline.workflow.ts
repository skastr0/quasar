import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const GlyphPlan = Schema.Struct({
  status: Schema.Literal("ready", "escalate", "blocked"),
  summary: Schema.String,
  implementationNotes: Schema.Array(Schema.String),
  filesToInspect: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  proposedValidation: Schema.Array(Schema.String),
});

const BuildReport = Schema.Struct({
  status: Schema.Literal("built", "escalate", "blocked"),
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String),
  implementationNotes: Schema.Array(Schema.String),
  validationRun: Schema.Array(Schema.Struct({
    command: Schema.String,
    result: Schema.Literal("passed", "failed", "skipped"),
    notes: Schema.String,
  })),
  followUpNeeded: Schema.Array(Schema.String),
});

const ReviewReport = Schema.Struct({
  verdict: Schema.Literal("pass", "needs-work", "insufficient-evidence"),
  summary: Schema.String,
  blockingFindings: Schema.Array(Schema.String),
  nonBlockingFindings: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
});

const GlyphSynthesis = Schema.Struct({
  glyphId: Schema.String,
  decision: Schema.Literal("continue", "repair", "escalate", "blocked"),
  summary: Schema.String,
  nextAction: Schema.String,
  evidence: Schema.Array(Schema.String),
});

type GlyphRef = {
  readonly id: string;
  readonly revision: string;
  readonly reviewers: readonly (
    | "requirementsTracer"
    | "verificationReviewer"
    | "contractReviewer"
    | "dataModelReviewer"
    | "reliabilityReviewer"
    | "consolidationReviewer"
    | "simplicityReviewer"
  )[];
};

const TOWER_PROJECT = "quasar";
const FORGE_ORBIT = "forge";

const grokBuilder = { worker: "grok", model: "grok-build" } as const;
const grokReview = { worker: "grok", model: "grok-build" } as const;

const mustBeReady = (label: string) => ({
  name: `${label}-ready`,
  check: ({ output }: { output: typeof GlyphPlan.Type }) => output.status === "ready"
    ? Effect.void
    : Effect.fail(new Error(`planning status must be ready, got ${output.status}: ${output.summary}`)),
  repairPrompt: () =>
    "Return a ready plan if the glyph is buildable. If it truly is not buildable, keep blocked/escalate and explain the exact blocker.",
});

const mustBeBuilt = (label: string) => ({
  name: `${label}-built`,
  check: ({ output }: { output: typeof BuildReport.Type }) => output.status === "built"
    ? Effect.void
    : Effect.fail(new Error(`build status must be built, got ${output.status}: ${output.summary}`)),
  repairPrompt: () =>
    "Continue the same glyph. Complete code and tests before returning built. Return escalate/blocked only with a concrete reason.",
});

const mustReview = (label: string) => ({
  name: `${label}-review-verdict`,
  check: ({ output }: { output: typeof ReviewReport.Type }) => output.verdict !== "insufficient-evidence"
    ? Effect.void
    : Effect.fail(new Error(`review returned insufficient evidence: ${output.summary}`)),
  repairPrompt: () =>
    "Re-open the relevant files/diff and produce evidence-backed review findings.",
});

const reviewerAgent = (name: GlyphRef["reviewers"][number]) => {
  switch (name) {
    case "requirementsTracer": return agents.forge.requirementsTracer;
    case "verificationReviewer": return agents.forge.verificationReviewer;
    case "contractReviewer": return agents.forge.contractReviewer;
    case "dataModelReviewer": return agents.forge.dataModelReviewer;
    case "reliabilityReviewer": return agents.forge.reliabilityReviewer;
    case "consolidationReviewer": return agents.forge.consolidationReviewer;
    case "simplicityReviewer": return agents.forge.simplicityReviewer;
  }
};

/** Tower owns glyph content. Workflow owns routing order, cache keys, and reviewer fan-out. */
const glyphQueue = [
  { id: "QSR-096", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "simplicityReviewer"] },
  { id: "QSR-097", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "contractReviewer"] },
  { id: "QSR-098", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "dataModelReviewer"] },
  { id: "QSR-099", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "reliabilityReviewer"] },
  { id: "QSR-100", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "reliabilityReviewer"] },
  { id: "QSR-101", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "contractReviewer"] },
  { id: "QSR-102", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "reliabilityReviewer"] },
  { id: "QSR-103", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "contractReviewer"] },
  { id: "QSR-104", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "reliabilityReviewer"] },
  { id: "QSR-105", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "reliabilityReviewer"] },
  { id: "QSR-106", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "reliabilityReviewer"] },
  { id: "QSR-107", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer", "consolidationReviewer"] },
  { id: "QSR-108", revision: "v1", reviewers: ["requirementsTracer", "verificationReviewer"] },
] as const satisfies readonly GlyphRef[];

const towerReadInstruction = (glyphId: string) =>
  [
    `Read the glyph from Tower before any other work:`,
    `tower_read_glyph(project_key: "${TOWER_PROJECT}", orbit: "${FORGE_ORBIT}", id: "${glyphId}")`,
    `Tower is the sole source of truth for scope, acceptance criteria, context, and notes.`,
    `Do not infer glyph intent from workflow code or stale copies.`,
  ].join("\n");

const runGlyph = (wf: Parameters<Parameters<typeof defineWorkflow>[0]["run"]>[0], glyph: GlyphRef) =>
  Effect.gen(function* () {
    const plan = yield* wf.runTask(defineTask({
      id: `${glyph.id}-plan`,
      cacheKey: `quasar-ingest-pipeline/${glyph.id}/${glyph.revision}/plan`,
      agent: agents.forge.explorer,
      worker: grokBuilder,
      output: GlyphPlan,
      finish: { maxRepairs: 1, criteria: [mustBeReady(glyph.id)] },
      prompt: `Forge explore phase for one Tower glyph. Do not edit files.

${towerReadInstruction(glyph.id)}

Glyph id: ${glyph.id}
Read AGENTS.md and the Effect local-server architecture plan before planning.
Return JSON only: status, summary, implementationNotes, filesToInspect, risks, proposedValidation. status must be ready, escalate, or blocked.`,
    }));

    const build = yield* wf.runTask(defineTask({
      id: `${glyph.id}-build`,
      cacheKey: `quasar-ingest-pipeline/${glyph.id}/${glyph.revision}/build`,
      agent: agents.forge.builder,
      worker: grokBuilder,
      output: BuildReport,
      finish: { maxRepairs: 1, criteria: [mustBeBuilt(glyph.id)] },
      prompt: `Forge build phase for one Tower glyph. You may edit files and run validation. One atomic conventional commit per glyph.

${towerReadInstruction(glyph.id)}

Glyph id: ${glyph.id}
Plan:
${JSON.stringify(plan, null, 2)}

AGENTS.md constraints: measured data is the contract; delete over deprecate; no invented byte budgets.
Run bun run typecheck && bun run test unless the glyph explicitly says otherwise.
Return JSON only: status, summary, filesChanged, implementationNotes, validationRun, followUpNeeded. status must be built, escalate, or blocked.`,
    }));

    const reviews = yield* Effect.all(
      glyph.reviewers.map((reviewer) => wf.runTask(defineTask({
        id: `${glyph.id}-review-${reviewer}`,
        cacheKey: `quasar-ingest-pipeline/${glyph.id}/${glyph.revision}/review/${reviewer}`,
        agent: reviewerAgent(reviewer),
        worker: grokReview,
        output: ReviewReport,
        finish: { maxRepairs: 1, criteria: [mustReview(`${glyph.id}-${reviewer}`)] },
        prompt: `Forge review phase for one completed glyph. Do not edit files.

${towerReadInstruction(glyph.id)}

Glyph id: ${glyph.id}
Builder report:
${JSON.stringify(build, null, 2)}

Review the diff and validation evidence against the Tower glyph acceptance criteria.
Return JSON only: verdict, summary, blockingFindings, nonBlockingFindings, evidence. verdict must be pass, needs-work, or insufficient-evidence.`,
      }))),
      { concurrency: 1 },
    );

    return yield* wf.runTask(defineTask({
      id: `${glyph.id}-synthesize`,
      cacheKey: `quasar-ingest-pipeline/${glyph.id}/${glyph.revision}/synthesize`,
      agent: agents.forge.orchestratorEngineer,
      worker: grokReview,
      output: GlyphSynthesis,
      finish: { maxRepairs: 1, criteria: [] },
      prompt: `Synthesize the glyph outcome for workflow orchestration.

${towerReadInstruction(glyph.id)}

Glyph id: ${glyph.id}
Builder report:
${JSON.stringify(build, null, 2)}
Reviews:
${JSON.stringify(reviews, null, 2)}

Return JSON only: glyphId, decision, summary, nextAction, evidence.
decision must be continue, repair, escalate, or blocked. Choose repair if any blocking finding needs builder attention.`,
    }));
  });

export default defineWorkflow({
  name: "quasar-ingest-pipeline",
  run: (wf) => Effect.gen(function* () {
    const results = [];
    for (const glyph of glyphQueue) {
      const result = yield* runGlyph(wf, glyph);
      results.push(result);
      if (result.decision !== "continue") {
        return { stoppedAt: glyph.id, results };
      }
    }
    return { stoppedAt: null, results };
  }),
});
