/**
 * Quasar productization-plan council -> fusion.
 *
 * Run from the quasar git root:
 *   prism workflow validate workflows/quasar-productization-plan-council.workflow.ts
 *   prism workflow run workflows/quasar-productization-plan-council.workflow.ts
 *
 * Assesses the QSR-229..242 plan (v3 search substrate + productization) before
 * any build starts. Heterogeneous council: grok x3 under three different
 * adversarial angles + codex-cli grounding the plan against the actual repo,
 * then a claude-code fusion into ONE verdict with concrete glyph amendments.
 *
 * Every council member is REQUIRED to mine the project's own session history
 * through quasar itself — the tool under review is also the evidence store.
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const BRIEF = `You are on an adversarial review council for Quasar — a self-hosted, cross-harness session-intelligence server (ingests AI coding-session histories from 7 harnesses into one SQLite truth store, serves lexical/semantic/fusion search to agents over CLI/MCP/HTTP). The owner intends to productize it as best-in-class open-source. A 14-glyph plan (QSR-229..242) was just laid down. Your job: find DEAD ENDS, PAST REPEATS (things this project already tried and abandoned — it has been through ~10 architectures in a month), and MISSING work, before a line is built.

THE PLAN UNDER REVIEW (full spec: docs/architecture/quasar-first-principles-rearchitecture-2026-07-03.md — READ IT):
Arc 1 (substrate): QSR-229 spike measuring FTS5 + exact f16 scan + local ONNX on the real 669k-row corpus (go/no-go gate) -> QSR-230 SQLite FTS5 lexical cutover behind the HTTP contract -> QSR-231 message_vectors f16 BLOBs in SQLite + local ONNX nomic-embed default (BYO-cloud fallback) -> QSR-232 RAM-resident f16 matrix + native exact-scan kernel (usearch/simsimd), shadow-mode diff vs live LanceDB -> QSR-233 cutover + DELETE LanceDB and all its scaffolding (readiness gate, reconcile/index-repair workers, optimize/GC).
Arc 2 (hardening): QSR-234 rematerialize verbs (rebuild any derived layer, build-aside + atomic swap) / QSR-235 backup + restore drill / QSR-236 watchdog with four alarm classes.
Arc 3 (product): QSR-237 zero-config first-run (<10 min to first search) / QSR-238 public-repo readiness (license, secrets audit, NAMING — collides with Quasar Framework) / QSR-239 CI matrix + multi-arch images + smoke-gated releases / QSR-240 MCP-first distribution / QSR-241 docs via proof-gated pipeline / QSR-242 multimedia embedding (post-1.0).
Core claims to attack: (1) at 660k x 768d, exact brute-force scan beats ANY vector index (latency parity, recall 1.0, exact filtered search, zero index machinery); (2) FTS5 handles 650MB of text at sub-100ms; (3) local ONNX embedding is viable on a Mac mini and vector-compatible with the 305k cached Synthetic/nomic embeddings; (4) deleting LanceDB removes the entire failure taxonomy of the past month; (5) the plan loses no feature and no performance.

MANDATORY EVIDENCE PROTOCOL — use quasar itself to mine the project's history (it is running and indexes this very project's sessions). Run these as PLAIN TERMINAL COMMANDS only:
  quasar search --query "<terms>" --mode fusion --project-key git:github.com/skastr0/quasar --limit 10
  quasar messages --session-id <id> --limit 200        (read around a hit)
CRITICAL: quasar session ids (e.g. "claude:37d1ed...", "codex:6a3d76...") are QUASAR identifiers. NEVER pass them to your own harness's session, resume, fork, or subagent tools — they do not exist in your harness and will crash your session. The ONLY way to read them is the quasar CLI via the terminal.
Mine at least: prior FTS/SQLite attempts, prior brute-force/scan decisions, prior local-embedding attempts, prior "delete LanceDB" or "sqlite-vec" or "HNSW" discussions, the three disk-explosion eras, the readiness-gate saga, native-dependency pain (Bun + node bindings), and anything resembling YOUR angle. Cite sessionId+seq for every historical claim. Also read the repo: packages/server/src/{search.ts,lancedb.ts,maintenance.ts,embeddings.ts}, packages/cli, Dockerfile, docs/architecture/. Current live facts: 669,190 messages, all 3 modes sub-second, optimize permanently OFF, disk 12G, 1,819 dead-lettered embed jobs.

Do not relitigate the already-decided: LanceDB-with-optimize-loops is dead, Convex is dead, the corpus is small by design (boundary-rejected). Attack the NEW plan. Findings must be concrete: name the glyph, the file, the measured risk, and what to change. Return JSON matching the output schema only.`;

const Finding = Schema.Struct({
  title: Schema.String,
  category: Schema.Literal(
    "dead-end",
    "past-repeat",
    "missing",
    "feasibility",
    "sequencing",
    "product",
  ),
  severity: Schema.Literal("blocker", "high", "medium", "low"),
  affectedGlyphs: Schema.Array(Schema.String),
  evidence: Schema.String,
  quasarCitations: Schema.Array(Schema.String),
  recommendation: Schema.String,
});

const CouncilLens = Schema.Struct({
  angle: Schema.String,
  headline: Schema.String,
  summary: Schema.String,
  planVerdict: Schema.Literal(
    "sound",
    "sound-with-amendments",
    "needs-rework",
    "unsound",
  ),
  findings: Schema.Array(Finding),
  strongestPartOfPlan: Schema.String,
  weakestPartOfPlan: Schema.String,
  dissent: Schema.String,
});

const FusionVerdict = Schema.Struct({
  executiveSummary: Schema.String,
  planVerdict: Schema.Literal(
    "sound",
    "sound-with-amendments",
    "needs-rework",
    "unsound",
  ),
  confirmedFindings: Schema.Array(Finding),
  rejectedFindings: Schema.Array(
    Schema.Struct({ title: Schema.String, whyRejected: Schema.String }),
  ),
  glyphAmendments: Schema.Array(
    Schema.Struct({
      glyph: Schema.String,
      action: Schema.Literal("amend", "add", "drop", "resequence"),
      change: Schema.String,
    }),
  ),
  councilConsensus: Schema.Array(Schema.String),
  councilDissent: Schema.Array(Schema.String),
  openQuestionsForOwner: Schema.Array(Schema.String),
});

const explorer = agents.forge.explorer;
const orchestrator = agents.forge.orchestratorEngineer;

const ANGLES: ReadonlyArray<{
  id: string;
  worker: "grok" | "codex-cli";
  model: string;
  angle: string;
}> = [
  {
    id: "council-grok-historian",
    worker: "grok",
    model: "grok-build",
    angle: `DEAD-END HISTORIAN. Your single question: which parts of this plan has this project ALREADY TRIED and abandoned, and does the plan know why? Mine quasar hard for: prior SQLite/FTS attempts, sqlite-vec / HNSW / brute-force discussions, prior local-embedding attempts, prior atomic-swap/build-aside schemes, the record-stream era, the Convex era, the three disk explosions, the readiness-gate saga. For each overlap: did it fail for a reason that STILL APPLIES, or a reason the new plan removes? A past failure whose cause survives into the new plan is a blocker finding.`,
  },
  {
    id: "council-grok-feasibility",
    worker: "grok",
    model: "grok-build",
    angle: `FEASIBILITY SKEPTIC. Attack the load-bearing numbers and native-dependency assumptions: exact f16 scan latency at 669k x 768 under Bun (which kernel actually works — usearch exact? simsimd bindings? pure-JS fallback cost?); FTS5 build time + query latency + MATCH-escaping pitfalls at 650MB in bun:sqlite; ONNX runtime on Mac mini inside a linux/arm64 Docker container (does onnxruntime-node even ship that?); local-vs-Synthetic nomic vector parity (pooling/normalization/prefix differences); RAM envelope (matrix + ONNX model + Bun heap on the mini); boot-load time; concurrent scan throughput. Mine quasar for every past native-binding or Bun-compatibility fight this project had. Number every claim; a plan number you cannot reproduce with arithmetic or a cited source is a finding.`,
  },
  {
    id: "council-grok-product",
    worker: "grok",
    model: "grok-build",
    angle: `PRODUCTIZATION SKEPTIC. Attack Arc 2/3 as an open-source maintainer would: what does "best-in-class open-source session intelligence" ACTUALLY require that the plan misses? Candidates to test: privacy story (this tool ingests people's entire AI conversations — redaction? consent? .gitignore-class exclusions?), multi-user/auth on the HTTP surface, upgrade/migration story between released versions (SQLite schema migrations for strangers' data), Windows/WSL, harness-format drift when vendors change their session formats (who fixes adapters?), license implications of deps, the naming collision, retention/deletion (GDPR-ish delete-my-session), and whether <10-min zero-config is credible with a local ONNX model download. Mine quasar for past operational pain a stranger would hit harder than the owner did.`,
  },
  {
    id: "council-codex-repo",
    worker: "codex-cli",
    model: "gpt-5.4-mini",
    angle: `REPO-REALITY REVIEWER. You ground the plan against the actual code. Read the server and CLI packages end to end: does the plan's decomposition match the real seams (SearchService, DurableQueue, workers, HTTP contract tests, Docker image)? What does QSR-233's deletion ACTUALLY touch — enumerate the files/modules that die and the ones that must survive; find hidden couplings (does anything besides search read LanceDB? does the TUI or MCP surface assume readiness fields that die with the gate?). Check the contract tests actually pin what the plan assumes they pin. Verify the queue/embed worker can carry QSR-231 dual-write without a rewrite. Flag any glyph whose acceptance criteria the current repo makes impossible or trivially wrong. Use quasar when git blame is not enough for the WHY.`,
  },
];

const councilTask = (m: {
  id: string;
  worker: "grok" | "codex-cli";
  model: string;
  angle: string;
}) =>
  defineTask({
    id: m.id,
    agent: explorer,
    worker: { worker: m.worker, model: m.model },
    output: CouncilLens,
    cacheKey: `quasar-productization-plan-council/${m.id}/v2`,
    prompt: `${BRIEF}\n\nYOUR ANGLE — ${m.angle}\n\nSet the angle field to a short name for your lens. Every schema field is required: if you have no dissent, set dissent to an empty string.`,
  });

export default defineWorkflow({
  name: "quasar-productization-plan-council",
  run: (wf) =>
    Effect.gen(function* () {
      const [historian, feasibility, product, repo] = yield* Effect.all(
        ANGLES.map((m) => wf.runTask(councilTask(m))),
        { concurrency: "unbounded" },
      );

      const fusion = yield* wf.runTask(
        defineTask({
          id: "fuse-verdict",
          agent: orchestrator,
          worker: { worker: "claude-code" },
          output: FusionVerdict,
          cacheKey: "quasar-productization-plan-council/fusion/v2",
          prompt: `Fuse four adversarial council lenses on the QSR-229..242 plan into ONE verdict. Be a skeptical judge, not a stenographer: confirm findings only when the evidence (quasar citations, repo paths, arithmetic) actually supports them; reject double-counted or speculative ones with reasons. Where findings conflict, weigh the one with primary-source evidence.

Dead-end historian lens:
${JSON.stringify(historian, null, 2)}

Feasibility skeptic lens:
${JSON.stringify(feasibility, null, 2)}

Productization skeptic lens:
${JSON.stringify(product, null, 2)}

Repo-reality lens:
${JSON.stringify(repo, null, 2)}

Rules:
- confirmedFindings ranked most severe first; keep quasar citations attached.
- glyphAmendments must be executable edits to the QSR-229..242 sequence: amend scope/acceptance, add a missing glyph (propose id QSR-243+), drop, or resequence — with the exact change.
- councilDissent preserves real disagreement; do not synthesize false consensus.
- openQuestionsForOwner: only genuine owner calls (product scope, privacy stance, naming) — not engineering questions the plan can answer.`,
        }),
      );

      return {
        lenses: { historian, feasibility, product, repo },
        fusion,
      };
    }),
});
