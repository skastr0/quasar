/**
 * Quasar "killer product" council -> fusion.
 *
 * Run from the quasar git root with the prism-dev CLI (from source — the compiled
 * dev binary is missing @opentui native module):
 *   bun /Users/guilhermecastro/Projects/prism/src/cli.ts workflow validate workflows/quasar-killer-council.workflow.ts
 *   bun /Users/guilhermecastro/Projects/prism/src/cli.ts workflow run      workflows/quasar-killer-council.workflow.ts \
 *       --worker claude-code --permission permissive --max-concurrent-tasks 6 --task-timeout-ms 900000
 *
 * Five heterogeneous lenses (grok x2, kimi-code, opencode, antigravity-cli),
 * each pushing Quasar to the research/product edge from its own angle, then a
 * claude-code fusion that synthesizes ONE ranked program: architecture wins,
 * unreal-performance wins, edge-science bets, and killer features — with strong
 * alternatives and preserved dissent.
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const BRIEF = `QUASAR — what it is: a local, private, cross-harness semantic search + MEMORY engine over the user's OWN AI-coding-session history across 7 harnesses (codex, claude, grok, opencode, kimi, hermes, antigravity). Scale today: ~4,400 sessions, ~180k searchable messages (roles: user / assistant / reasoning).

ARCHITECTURE (current, working):
- packages/cli: reads each harness's on-disk history -> per-harness adapters extract CLEAN prose (envelope peeled, agent-generated JSON kept) -> POST to the server.
- packages/server: SQLite = truth store (sessions, messages); LanceDB = search index (FTS text_idx + a vector table); always-on background workers (embeddings, index-repair, maintenance); a FAIL-CLOSED readiness gate (/ready returns 503 until the index is provably consistent with truth — degraded results are structurally impossible).
- Embeddings: nomic-embed-text-v1.5 (768-dim) via the synthetic API — FREE + private hosting in the user's subscription. There is NO embedding-throughput constraint: push synthetic as hard as you want. Local models are NOT useful here (the mac mini is busy); do not propose them as the main path.
- Search: lexical (FTS / BM25), semantic (vector cosine), fusion (Reciprocal Rank Fusion, fusionK=60). Rows are per-message, keyed sessionId:seq:role.

CURRENT STATE (measured today):
- Search WORKS: /ready=200, clean prose, semantic relevant, cross-harness, reasoning searchable, fail-closed.
- Benchmark vs grep: Quasar WINS 10-3 across 13 queries, ~1.9x relevance (3.6 vs 1.9 on a 0-5 scale), CATEGORICAL wins on paraphrase / cross-harness / natural-question, parity on exact-identifier. grep wins ONLY when the user already knows the exact literal token (e.g. a config key). Quasar's natural-language modes currently MISS single-literal / config-key answers (a real gap: query "claude purge fix" missed the literal cleanupPeriodDays:3650).
- Known perf gap: upsertMessageRows uses LanceDB mergeInsert = O(table) per call -> a bulk re-index / re-embed is QUADRATIC (~tens of minutes, one-time; steady-state incremental is fine).

THE ASK — push Quasar to an ABSOLUTE KILLER product. Operate at the EDGE; cite real techniques and papers where they apply. Cover all of:
1. ARCHITECTURE improvements (indexing / embedding / search / storage / serving / the CLI<->server contract).
2. PERFORMANCE — extract UNREAL performance from what exists: LanceDB ANN params (IVF_PQ vs HNSW), product/scalar quantization, Matryoshka dimension truncation, batching, killing the mergeInsert quadratic with a linear bulk-write path, caching, latency/recall tradeoffs. Quantify expected gains.
3. SCIENCE / retrieval research at the edge — be specific about what would measurably beat BM25 + nomic + RRF for THIS corpus: e.g. late-interaction / multi-vector (ColBERTv2 / PLAID), learned sparse (SPLADE / uniCOIL), cross-encoder reranking, HyDE / query expansion / query understanding, fusion beyond RRF (score-aware / learned / distribution-calibrated), embedding adapters or domain fine-tuning to code-session text, Matryoshka representation learning, instruction-tuned query embeddings, temporal & graph retrieval, RAG-over-your-own-history, agentic long-term memory.
4. FEATURES — what makes cross-harness AI-session memory INDISPENSABLE: e.g. "what did I learn / decide", auto session summaries, cross-session linking / a knowledge graph, timeline / temporal queries, dedup of repeated reasoning, an agent-memory MCP every coding agent queries before acting, proactive surfacing ("you solved this before"), provenance / citation, relevance feedback / personalization, multi-modal (tool-calls, diffs, code).
5. Surface IDEAS, OPTIONS, and STRONG ALTERNATIVES — not a single answer. Give the option space, your RECOMMENDED bet, and where you would DISSENT from the obvious choice.

Grounding: you MAY read packages/cli/src and packages/server/src, and run \`quasar-dev search --query "..." --mode {lexical|semantic|fusion} --server http://127.0.0.1:6180\` to see real results. Prefer concrete (files, techniques, params, expected gains) over hand-waving. Return ONLY JSON matching the output schema.`;

const Idea = Schema.Struct({
  title: Schema.String,
  category: Schema.Literal("architecture", "performance", "science", "feature", "moonshot"),
  what: Schema.String,
  whyItMatters: Schema.String,
  howConcrete: Schema.String,
  expectedGain: Schema.String,
  paperOrTechnique: Schema.optional(Schema.String),
  risk: Schema.String,
});

const CouncilLens = Schema.Struct({
  worker: Schema.String,
  lens: Schema.String,
  headline: Schema.String,
  summary: Schema.String,
  ideas: Schema.Array(Idea),
  strongAlternatives: Schema.Array(Schema.String),
  dissent: Schema.optional(Schema.String),
});

const FusionPlan = Schema.Struct({
  executiveSummary: Schema.String,
  rankedInitiatives: Schema.Array(
    Schema.Struct({
      rank: Schema.Number,
      title: Schema.String,
      category: Schema.String,
      outcome: Schema.String,
      approach: Schema.String,
      strongestAlternative: Schema.String,
      effort: Schema.String,
      payoff: Schema.String,
    }),
  ),
  researchBets: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      hypothesis: Schema.String,
      paperOrTechnique: Schema.String,
      experiment: Schema.String,
    }),
  ),
  killerFeatures: Schema.Array(
    Schema.Struct({ title: Schema.String, userValue: Schema.String, enabledBy: Schema.String }),
  ),
  performanceWins: Schema.Array(Schema.String),
  councilConsensus: Schema.Array(Schema.String),
  councilDissent: Schema.Array(Schema.String),
  sequencedRoadmap: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
});

const councilTask = (
  id: string,
  worker: "grok" | "kimi-code" | "opencode" | "antigravity-cli",
  model: string,
  lens: string,
) =>
  defineTask({
    id,
    agent: agents.forge.explorer,
    worker: { worker, model },
    output: CouncilLens,
    cacheKey: `killer-council/${id}/v2`,
    prompt: `${BRIEF}

YOUR LENS (${id}): ${lens}

Go DEEP on your lens (most of your ideas there), but still touch the other dimensions where you have a strong view. Be ambitious and specific. Include at least one moonshot. Return ONLY JSON matching the schema: { worker, lens, headline, summary, ideas[ {title, category, what, whyItMatters, howConcrete, expectedGain, paperOrTechnique?, risk} ], strongAlternatives[], dissent? }.`,
  });

const RETRIEVAL_SCIENCE =
  "Retrieval / IR science at the research edge. Own dimension #3. What is the SOTA retrieval stack for a PERSONAL cross-harness code-session corpus, and what would measurably beat BM25 + nomic + RRF? Late interaction / multi-vector (ColBERTv2, PLAID), learned sparse (SPLADE), cross-encoder reranking, HyDE / query expansion, fusion beyond RRF (score-aware, learned, calibrated), Matryoshka, instruction-tuned query embeddings. Tie each idea to a paper/technique and to a measurable corpus gain. Directly propose a fix for the natural-language single-literal/config-key miss.";

const SYSTEMS_PERF =
  "Systems + performance. Own dimension #2. Extract UNREAL performance from LanceDB + the synthetic embedding pipeline: kill the mergeInsert O(table) quadratic with a linear bulk-write path, ANN index choice + params (IVF_PQ vs HNSW, nprobe/efSearch), product/scalar quantization, Matryoshka dimension truncation for a fast first-stage then full-dim rerank, batching/concurrency against synthetic, caching, memory & tail-latency. Quantify expected gains (x-factors, ms, GB).";

const EMBEDDINGS_ML =
  "Embeddings + ML modeling. Embedding QUALITY for code-session text: domain adaptation / LoRA adapters / fine-tuning a small reranker on the user's own click/relevance signal, multi-vector vs single-vector, instruction / query-side embeddings, hard-negative mining from the corpus, and the modeling fix for the config-key miss. What modeling move raises relevance the most, given synthetic-hosted nomic is the base and throughput is free?";

const PRODUCT_FEATURES =
  "Product + features. Own dimension #4. The KILLER feature set for a personal cross-harness AI-memory engine: an agent-memory MCP every coding agent queries before acting, proactive 'you solved this before' surfacing, cross-session knowledge graph, 'what did I learn/decide', auto session summaries, temporal/timeline queries, dedup of repeated reasoning, provenance/citation, relevance feedback. What makes this INDISPENSABLE vs a search box? Be ambitious and concrete about UX + the data it needs.";

const ARCH_DATAMODEL =
  "Architecture + data model. The CLI<->server split, truth-store<->index coherence, and the schema/data-model needed to unlock the science + features above (temporal, graph, multi-vector, multi-modal tool-calls/diffs). Reliability and the fail-closed design. Give STRONG alternatives to the current shape (e.g. event-sourced truth, columnar, a graph layer, single-vs-multi index) and say which you'd bet on and why.";

export default defineWorkflow({
  name: "quasar-killer-council",
  run: (wf) =>
    Effect.gen(function* () {
      // Resilient: a dead/unauthenticated worker yields a null lens instead of
      // killing the whole council; fusion synthesizes from whoever returned.
      const safe = (task: ReturnType<typeof councilTask>) =>
        wf.runTask(task).pipe(Effect.catchAll(() => Effect.succeed(null)));

      const [grokScience, grokSystems, kimi, opencode, antigravity] = yield* Effect.all(
        [
          safe(councilTask("grok-retrieval-science", "grok", "grok-build", RETRIEVAL_SCIENCE)),
          safe(councilTask("grok-systems-performance", "grok", "grok-build", SYSTEMS_PERF)),
          safe(councilTask("kimi-embeddings-ml", "kimi-code", "kimi-code/kimi-for-coding", EMBEDDINGS_ML)),
          safe(councilTask("opencode-product-features", "opencode", "synthetic/hf:moonshotai/Kimi-K2.6", PRODUCT_FEATURES)),
          safe(councilTask("antigravity-architecture", "antigravity-cli", "gpt-5.4-mini", ARCH_DATAMODEL)),
        ],
        { concurrency: "unbounded" },
      );

      // Fusion is performed by claude-opus (the orchestrator reading this run's
      // output) rather than a prism claude-code task — the orchestrator-engineer
      // modelspace has no concrete claude-code model, and claude-opus IS the
      // intended fusion synthesizer. The council is the prism fan-out.
      return { grokScience, grokSystems, kimi, opencode, antigravity };
    }),
});
