/**
 * Quasar search-architecture council -> fusion.
 *
 * Run from the quasar git root:
 *   prism workflow validate workflows/quasar-search-architecture-council.workflow.ts
 *   prism workflow run workflows/quasar-search-architecture-council.workflow.ts
 *
 * Heterogeneous council (grok + codex-cli + kimi-code + opencode), each analyzing
 * the same brief from its own harness lens, then a claude-code fusion that
 * synthesizes ONE ranked architecture plan.
 *
 * Star goal: a single Quasar query must beat grep across ALL 7 harnesses
 * (FTS + vector + fusion), ranked by relevance, never stalling, never serving
 * degraded results.
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const BRIEF = `You are on an architecture council for Quasar — a local cross-harness search engine over the user's own AI coding-session history across 7 harnesses (codex, claude, grok, opencode, kimi, hermes, antigravity). The star goal: a single query must beat grep — semantic + lexical + fusion, aggregated across ALL harnesses, ranked by relevance, never stalling, never returning degraded results.

READ FIRST — ground every claim in the real repo + data, do not speculate:
- /tmp/quasar-harness-samples.md — measured per-harness raw-vs-ingested samples + current failures.
- CLI adapters (text extraction lives here): packages/cli/src/adapters/{codex,claude,grok,opencode,kimi,hermes,antigravity}.ts
- Server search/index: packages/server/src/{search.ts,lancedb.ts,maintenance.ts,embeddings.ts,server.ts}
- Live data: quasar-dev search --query "..." --mode {lexical|semantic|fusion} --server http://127.0.0.1:6180 ; SQLite truth store is inside the server container.

MEASURED PROBLEMS (verify against the code/data, then design the fix):
1. TEXT ROT: message.text is the raw on-disk JSON record, not extracted prose, for codex (100% of 133955 msgs), opencode (100%), grok (85%), hermes (25%). The real text IS present inside the JSON (e.g. codex {"type":"user_message","message":"<text>"} or payload.content[].text; grok {"content":[{"type":"text","text":"<text>"}]}). So FTS + embeddings index JSON scaffolding -> semantic returns negative-cosine garbage, ranking skews to JSON harnesses, search loses to grep.
2. INDEX STALLS SILENTLY: LanceDB FTS/vector indexes do not refresh with ingest; a re-ingest left the FTS index 0-indexed, and /search served the stale index as HTTP 200 (degraded results presented as valid). Degraded search must be IMPOSSIBLE — fail closed (e.g. 503) until the index is provably consistent with the truth store, and heal automatically.
3. EMBEDDINGS: nomic-embed-text-v1.5 via the synthetic API (kept — free + private hosting in subscription). With JSON text fed in, embeddings are meaningless; make them properly usable.

YOUR LENS: speak from the strengths and limits of the {HARNESS} harness you run under. ESPECIALLY analyze the {HARNESS} harness's OWN on-disk format + its adapter (read a raw sample + the adapter source) and give the exact, concrete text-extraction fix for it (the precise JSON path to the message text). Then give cross-cutting recommendations for: (a) LanceDB indexing that can NEVER stall or serve degraded results (fail-closed readiness + auto-heal coupled to ingest), (b) embedding usability, (c) the cross-harness FTS/vector/fusion search design that beats grep.

Constraints: be concrete — name files, functions, JSON paths, commands. Prefer fail-closed boundaries over silent degradation. Disagree constructively where another harness would choose differently. Return JSON matching the output schema only.`;

const HarnessExtraction = Schema.Struct({
  harness: Schema.String,
  currentProblem: Schema.String,
  jsonPathToText: Schema.String,
  fix: Schema.String,
});

const CouncilLens = Schema.Struct({
  harness: Schema.Literal("grok", "codex-cli", "kimi-code", "opencode"),
  headline: Schema.String,
  summary: Schema.String,
  textExtraction: Schema.Array(HarnessExtraction),
  lancedbNeverStall: Schema.Array(Schema.String),
  searchFailClosed: Schema.Array(Schema.String),
  embeddingUsability: Schema.Array(Schema.String),
  crossHarnessSearchDesign: Schema.Array(Schema.String),
  beatGrepTactics: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  dissent: Schema.optional(Schema.String),
});

const FusionPlan = Schema.Struct({
  executiveSummary: Schema.String,
  rankedInitiatives: Schema.Array(
    Schema.Struct({
      rank: Schema.Number,
      title: Schema.String,
      outcome: Schema.String,
      glyph: Schema.String,
      milestones: Schema.Array(Schema.String),
    }),
  ),
  textExtractionPlan: Schema.Array(HarnessExtraction),
  lancedbReliabilityPlan: Schema.Array(Schema.String),
  embeddingPlan: Schema.Array(Schema.String),
  searchAcceptanceTests: Schema.Array(Schema.String),
  councilConsensus: Schema.Array(Schema.String),
  councilDissent: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
});

const explorer = agents.forge.explorer;
const orchestrator = agents.forge.orchestratorEngineer;

const councilTask = (
  id: string,
  harness: "grok" | "codex-cli" | "kimi-code" | "opencode",
) =>
  defineTask({
    id,
    agent: explorer,
    worker: { worker: harness },
    output: CouncilLens,
    cacheKey: `quasar-search-council/${harness}/v1`,
    prompt: `${BRIEF}\n\nYou are the **${harness}** council member. Set the harness field to "${harness}". Give special, concrete attention to the ${harness} harness's own data format + adapter.`,
  });

export default defineWorkflow({
  name: "quasar-search-architecture-council",
  run: (wf) =>
    Effect.gen(function* () {
      const [grok, codex, kimi, opencode] = yield* Effect.all(
        [
          wf.runTask(councilTask("council-grok", "grok")),
          wf.runTask(councilTask("council-codex", "codex-cli")),
          wf.runTask(councilTask("council-kimi", "kimi-code")),
          wf.runTask(councilTask("council-opencode", "opencode")),
        ],
        { concurrency: "unbounded" },
      );

      const fusion = yield* wf.runTask(
        defineTask({
          id: "fuse-architecture",
          agent: orchestrator,
          worker: { worker: "claude-code" },
          output: FusionPlan,
          cacheKey: "quasar-search-council/fusion/v1",
          prompt: `Fuse four heterogeneous council lenses into ONE ranked Quasar search-architecture plan. Each lens analyzed the same brief from its harness.

Grok lens:
${JSON.stringify(grok, null, 2)}

Codex lens:
${JSON.stringify(codex, null, 2)}

Kimi lens:
${JSON.stringify(kimi, null, 2)}

Opencode lens:
${JSON.stringify(opencode, null, 2)}

Rules:
- Merge duplicates; preserve valuable disagreement in councilDissent.
- textExtractionPlan: one concrete entry per affected harness (codex, opencode, grok, hermes) with the exact JSON path to the message text.
- lancedbReliabilityPlan: make degraded search IMPOSSIBLE (fail-closed readiness gate + auto-heal coupled to ingest) and indexing that cannot stall.
- searchAcceptanceTests: include "find a known user message by MEANING across harnesses, beating grep" and "search 503s while the index heals, never a degraded 200".
- Map initiatives to existing glyphs where they fit: QSR-224 (clean text extraction), QSR-223 (fail-closed search readiness), QSR-222 (incremental ingest). Propose new glyph ids only if a real gap exists.
- Be concrete enough that an engineer can open issues immediately.`,
        }),
      );

      return { lenses: { grok, codex, kimi, opencode }, fusion };
    }),
});
