/**
 * Fill the 2 lenses that failed the first killer-council run (grok systems-perf,
 * opencode product-features). Both produced content but died in prism's repair
 * path (session-resume on a schema-decode retry). Fix: a LOOSER output schema so
 * attempt 0 validates first try and the fragile repair-resume is never touched
 * (the 2 lenses that passed first-try in the first run had repairs=0).
 *
 *   bun /Users/guilhermecastro/Projects/prism/src/cli.ts workflow run \
 *     workflows/quasar-council-fill.workflow.ts --worker grok --permission permissive \
 *     --max-concurrent-tasks 4 --task-timeout-ms 900000 --detach
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const BRIEF = `QUASAR — a local, private, cross-harness semantic search + MEMORY engine over the user's OWN AI-coding-session history across 7 harnesses (codex, claude, grok, opencode, kimi, hermes, antigravity). ~4,400 sessions, ~180k searchable messages (roles user/assistant/reasoning).

ARCHITECTURE (working): packages/cli reads each harness's on-disk history -> per-harness adapters extract CLEAN prose -> POST to server. packages/server: SQLite truth store; LanceDB index (FTS text_idx + a vector table); always-on workers (embeddings, index-repair, maintenance); a FAIL-CLOSED readiness gate (/ready 503 until index is provably consistent with truth). Embeddings: nomic-embed-text-v1.5 (768-dim) via the synthetic API — FREE + private, no throughput limit; local models are NOT useful (mac mini is busy). Search: lexical (FTS/BM25), semantic (vector cosine), fusion (RRF k=60). Rows per-message keyed sessionId:seq:role.

STATE (measured): search WORKS, /ready=200, clean prose, semantic, cross-harness, fail-closed. Beats grep 10-3 (~1.9x relevance), categorical on paraphrase/cross-harness/natural-question, parity on exact-identifier. grep wins only when the user already knows the exact literal token; quasar's NL modes MISS single-literal/config-key answers (e.g. query "claude purge fix" missed the literal cleanupPeriodDays:3650). Known perf gap: upsertMessageRows uses LanceDB mergeInsert = O(table) per call -> bulk re-index is QUADRATIC.

THE ASK — push Quasar to an ABSOLUTE KILLER product. Operate at the EDGE; cite real techniques/papers. Cover: (1) ARCHITECTURE, (2) PERFORMANCE — extract UNREAL performance (LanceDB ANN params IVF_PQ vs HNSW, product/scalar quantization, Matryoshka dims, batching, linear bulk-write to kill the mergeInsert quadratic, caching), (3) SCIENCE at the edge (late-interaction ColBERTv2/PLAID, SPLADE learned sparse, cross-encoder rerank, HyDE/query understanding, fusion beyond RRF, embedding adapters/domain fine-tune, Matryoshka, temporal/graph retrieval, agentic memory), (4) FEATURES that make cross-harness AI-memory indispensable (agent-memory MCP, proactive "you solved this before", knowledge graph, "what did I learn/decide", auto summaries, dedup, provenance, relevance feedback), (5) IDEAS, OPTIONS, and STRONG ALTERNATIVES with your recommended bet and where you DISSENT.

You MAY read packages/cli/src and packages/server/src and run \`quasar-dev search --query "..." --mode {lexical|semantic|fusion} --server http://127.0.0.1:6180\`. Prefer concrete (files, techniques, params, expected gains).`;

// LOOSER schema: category is a free string (the enum was the decode-failure
// culprit); only title + what are required so a sparse idea still validates.
const Idea = Schema.Struct({
  title: Schema.String,
  what: Schema.String,
  category: Schema.optional(Schema.String),
  whyItMatters: Schema.optional(Schema.String),
  howConcrete: Schema.optional(Schema.String),
  expectedGain: Schema.optional(Schema.String),
  paperOrTechnique: Schema.optional(Schema.String),
  risk: Schema.optional(Schema.String),
});

const CouncilLens = Schema.Struct({
  worker: Schema.String,
  lens: Schema.String,
  headline: Schema.String,
  summary: Schema.String,
  ideas: Schema.Array(Idea),
  strongAlternatives: Schema.optional(Schema.Array(Schema.String)),
  dissent: Schema.optional(Schema.String),
});

const SYSTEMS_PERF =
  "Systems + performance. Own dimension #2. Extract UNREAL performance from LanceDB + the synthetic embedding pipeline: kill the mergeInsert O(table) quadratic with a linear bulk-write path, ANN index choice + params (IVF_PQ vs HNSW, nprobe/efSearch), product/scalar quantization, Matryoshka dimension truncation for a fast first-stage then full-dim rerank, batching/concurrency against synthetic, caching, memory & tail-latency. Quantify expected gains (x-factors, ms, GB).";

const PRODUCT_FEATURES =
  "Product + features. Own dimension #4. The KILLER feature set for a personal cross-harness AI-memory engine: an agent-memory MCP every coding agent queries before acting, proactive 'you solved this before' surfacing, cross-session knowledge graph, 'what did I learn/decide', auto session summaries, temporal/timeline queries, dedup of repeated reasoning, provenance/citation, relevance feedback. What makes this INDISPENSABLE vs a search box? Be ambitious and concrete about UX + the data it needs.";

const fillTask = (
  id: string,
  worker: "grok" | "opencode",
  model: string,
  lens: string,
) =>
  defineTask({
    id,
    agent: agents.forge.explorer,
    worker: { worker, model },
    output: CouncilLens,
    cacheKey: `killer-council/${id}/v3`,
    prompt: `${BRIEF}

YOUR LENS (${id}): ${lens}

Go DEEP on your lens. Be ambitious and specific; include at least one moonshot. For each idea, 'category' (if set) should be one lowercase word from: architecture, performance, science, feature, moonshot. Return ONLY a single JSON object matching: { worker, lens, headline, summary, ideas[ {title, what, category?, whyItMatters?, howConcrete?, expectedGain?, paperOrTechnique?, risk?} ], strongAlternatives?[], dissent? }. No prose outside the JSON.`,
  });

export default defineWorkflow({
  name: "quasar-council-fill",
  run: (wf) =>
    Effect.gen(function* () {
      const safe = (task: ReturnType<typeof fillTask>) =>
        wf.runTask(task).pipe(Effect.catchAll(() => Effect.succeed(null)));
      const [grokSystems, opencode] = yield* Effect.all(
        [
          safe(fillTask("grok-systems-performance", "grok", "grok-build", SYSTEMS_PERF)),
          safe(fillTask("opencode-product-features", "opencode", "synthetic/hf:moonshotai/Kimi-K2.6", PRODUCT_FEATURES)),
        ],
        { concurrency: "unbounded" },
      );
      return { grokSystems, opencode };
    }),
});
