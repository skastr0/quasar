/**
 * Quasar TUI product-direction council.
 *
 * Four heterogeneous lenses (grok, antigravity-cli, kimi-code, opencode) each
 * advise on what the Quasar TUI should BE — interaction model, result surface,
 * killer features, concrete layout (ASCII mockups), keybindings, v1 scope, and
 * each one's strongest dissent. The orchestrator (claude-opus) reads this run's
 * output and synthesizes ONE committed design spec. The council is the fan-out.
 *
 * Run from the quasar git root with the prism-dev CLI (from source — the
 * compiled prism binary is missing the @opentui native module):
 *   git add workflows/quasar-tui-product-council.workflow.ts
 *   bun /Users/guilhermecastro/Projects/prism/src/cli.ts workflow validate workflows/quasar-tui-product-council.workflow.ts
 *   bun /Users/guilhermecastro/Projects/prism/src/cli.ts workflow run      workflows/quasar-tui-product-council.workflow.ts \
 *       --worker claude-code --permission permissive --max-concurrent-tasks 6 --task-timeout-ms 900000
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const BRIEF = `QUASAR TUI — design council.

WHAT QUASAR IS: a local, private, cross-harness search + MEMORY engine over the user's OWN AI-coding-session history across 7 harnesses (codex, claude, grok, opencode, kimi, hermes, antigravity). It answers "where have I seen / solved / decided this before?" across every agent conversation the user has ever had. Scale TODAY (measured): 292 projects, 12,408 sessions, 659,441 searchable messages (roles: user / assistant / reasoning). This is a personal tool for ONE elite power user (the owner), not a team product.

THE DATA LAYER (already built, do not redesign it): a CLI that ALWAYS emits JSON (envelope { ok, command, data | error }) and talks to a local server. The TUI sits ON TOP OF THIS CLI (shells out to it). Available commands:
- search --query TEXT --mode lexical|semantic|fusion [--project-key K] [--role user|assistant] [--limit N]
    lexical = FTS/BM25 (instant, always available), semantic = nomic-768 vector cosine, fusion = Reciprocal Rank Fusion of both.
    A match = { key: "sessionId:seq:role", score, row: { sessionId, seq, role, projectKey, provider, text } }.
    IMPORTANT: semantic/fusion can transiently return { ok:false, error:{ code:"SearchIndexNotReady" } } while the index reconciles. The TUI MUST handle a not-ready mode gracefully (e.g. fall back to lexical, show a quiet status).
- sessions [--provider P] [--project-key K] [--limit N] -> list sessions
- messages --session-id ID [--limit N] -> read a whole session transcript (ordered messages)
- tool-calls [--session-id ID] [--project-key K] [--provider P] [--tool-name N] -> tool-call forensics (what the agent DID)
- tool-call --id ID -> one tool-call's full input/output
- projects [--limit N] -> list projects
- stats -> corpus + index health (counts, queue, workers, embeddings)

THE BUILD TARGET: a TUI written with @opentui/react (React reconciler over a native Zig terminal core: <box> <text> <input> <select> <scrollbox>, flexbox layout, useKeyboard, controlled focus), compiled INTO the quasar binary and launched as \`quasar tui\` (and bare \`quasar\` in a TTY). The SIBLING reference for taste is "rig" (same owner): warm near-black palette (#11100d bg) with a SINGLE amber accent (#d6a94a), barely-visible borders, a fixed ~36/64 list/detail split, an always-visible bottom keybinding bar, vim-flavored navigation (j/k), and pure testable key-dispatch logic. The owner's bar: this corpus is TINY (fits in memory), so everything must feel INSTANT; any non-instant path is a bug.

THE ASK — design the BEST minimalist-but-high-powered, power-user TUI for this. Be concrete and opinionated. Cover ALL of:
1. INTERACTION MODEL — the core loop and mental model. REPL? command palette? modal (vim-like) vs modeless? search-as-you-type vs search-on-enter? How does the user go query -> results -> read a session -> jump to a related session -> inspect tool calls -> get back out? What is the ONE paradigm you commit to and why?
2. RESULT SURFACE — how to present 659k-message-scale results so they're scannable and trustworthy: ranking, the snippet, match highlighting, provenance (which harness / project / when), grouping (by session? by project? flat?), how to show lexical-vs-semantic-vs-fusion, how to preview without leaving the list.
3. KILLER FEATURES — what makes the owner reach for this every single day (NOT a generic search box): e.g. instant preview, mode toggle, fuzzy project/harness filter, "open this session in $EDITOR", copy/yank a result, jump to related, saved/recent queries, tool-call drill-down, a "what did I decide" lens. Pick the few that matter most for v1 and the ambitious ones for later.
4. LAYOUT — give 1-2 CONCRETE ASCII mockups of the main screen(s) at ~120x40, using the rig aesthetic. Show panes, the input, the result list, the detail/preview, and the keybar. Make it real, not a wireframe gesture.
5. KEYBINDINGS — the power-user key map (return a list of {keys, action}). Be opinionated and ergonomic; favor single-key + vim-flavored; reserve a leader if useful.
6. V1 SCOPE — the smallest thing that is already indispensable, vs what waits. What do we build FIRST?
7. DISSENT — your single strongest push-back against the obvious "input box on top, results list left, detail right, keybar bottom" answer. What does the WRONG Quasar TUI look like, and what would the other council members miss?

Grounding: you MAY read /Users/guilhermecastro/Projects/quasar/packages/cli/src and /Users/guilhermecastro/Projects/rig/src/tui, and run \`quasar-dev search --query "..." --mode lexical --limit 5\` to see REAL results and calibrate. Prefer concrete (panes, keys, real snippets, real flows) over hand-waving. Return ONLY JSON matching the output schema.`;

const Idea = Schema.Struct({
  title: Schema.String,
  category: Schema.Literal("interaction", "result-surface", "feature", "layout", "keybinding", "moonshot"),
  what: Schema.String,
  whyItMatters: Schema.String,
  effort: Schema.Literal("S", "M", "L"),
  risk: Schema.String,
});

const KeyBinding = Schema.Struct({
  keys: Schema.String,
  action: Schema.String,
});

const CouncilLens = Schema.Struct({
  worker: Schema.String,
  lens: Schema.String,
  headline: Schema.String,
  interactionModelVerdict: Schema.String,
  summary: Schema.String,
  ideas: Schema.Array(Idea),
  mockups: Schema.Array(Schema.String),
  keybindings: Schema.Array(KeyBinding),
  v1Scope: Schema.Array(Schema.String),
  strongAlternatives: Schema.Array(Schema.String),
  dissent: Schema.optional(Schema.String),
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
    cacheKey: `quasar-tui-council/${id}/v1`,
    prompt: `${BRIEF}

YOUR LENS (${id}): ${lens}

Go DEEP on your lens (most of your ideas there), but still answer all 7 dimensions where you have a strong view — every lens must return at least one ASCII mockup and a keybinding map. Be ambitious, opinionated, and concrete. Set worker="${worker}". Return ONLY JSON matching the schema: { worker, lens, headline, interactionModelVerdict, summary, ideas[ {title, category, what, whyItMatters, effort, risk} ], mockups[], keybindings[ {keys, action} ], v1Scope[], strongAlternatives[], dissent? }.`,
  });

const INTERACTION_IA =
  "Interaction model + information architecture. Own dimension #1. What is the RIGHT mental model and core loop for a personal cross-harness AI-memory TUI over 12k sessions / 659k messages? Argue for ONE paradigm (REPL vs command-palette vs modal/vim vs miller-columns/browser vs timeline) and design the full query->results->read->jump->forensics->exit loop around it. How do modes (lexical/semantic/fusion) and filters (project/harness/role) fit the loop without cluttering it?";

const LAYOUT_DESIGN =
  "Layout, visual design + power-user ergonomics. Own dimensions #4 and #5. Give the most concrete screen design: ASCII mockups at ~120x40 in the rig aesthetic (warm-dark, single amber accent, ~36/64 split, bottom keybar), the pane structure, density, how match highlighting and provenance render, and a complete, ergonomic, vim-flavored keybinding map. Optimize for an elite power user: fuzzy filtering, multi-select, yank/pipe-out, instant preview, minimal chrome. Make the mockups REAL.";

const KILLER_FEATURES =
  "Killer features + daily-driver workflows. Own dimension #3. What makes the owner reach for THIS instead of grep or scrolling history — every day? Design the indispensable few for v1 (instant preview, mode toggle, project/harness fuzzy filter, read a full session, tool-call drill-down, open-in-$EDITOR, yank, recent/saved queries, jump-to-related) and the ambitious later set (a 'what did I decide' lens, cross-session linking, proactive 'you solved this before'). Be concrete about UX and which CLI command each feature drives.";

const PRODUCT_DISSENT =
  "Product direction + dissent. Own dimension #7. Push back HARD on the obvious 'input on top, results left, detail right, keybar bottom' answer. What does the WRONG Quasar TUI look like (over-built, modal-heavy, slow, mouse-dependent, a worse fuzzy-finder)? What would the other lenses miss? Offer the strongest ALTERNATIVE framing (e.g. is this really a fzf-pipe, a less-style pager, an editor plugin, an MCP, a notebook?) and say where minimalism should WIN over features.";

export default defineWorkflow({
  name: "quasar-tui-product-council",
  run: (wf) =>
    Effect.gen(function* () {
      // Resilient: a dead/unauthenticated worker yields a null lens instead of
      // killing the whole council; the orchestrator synthesizes from whoever
      // returned.
      const safe = (task: ReturnType<typeof councilTask>) =>
        wf.runTask(task).pipe(Effect.catchAll(() => Effect.succeed(null)));

      const [grok, antigravity, kimi, opencode] = yield* Effect.all(
        [
          safe(councilTask("grok-interaction-ia", "grok", "grok-build", INTERACTION_IA)),
          safe(councilTask("agy-layout-design", "antigravity-cli", "gpt-5.4-mini", LAYOUT_DESIGN)),
          safe(councilTask("kimi-killer-features", "kimi-code", "kimi-code/kimi-for-coding", KILLER_FEATURES)),
          safe(councilTask("opencode-product-dissent", "opencode", "synthetic/hf:moonshotai/Kimi-K2.6", PRODUCT_DISSENT)),
        ],
        { concurrency: "unbounded" },
      );

      return { grok, antigravity, kimi, opencode };
    }),
});
