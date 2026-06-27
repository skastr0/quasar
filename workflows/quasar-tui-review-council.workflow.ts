/**
 * Quasar TUI review council. Four heterogeneous lenses (grok, antigravity-cli,
 * kimi-code, opencode) review the BUILT TUI — code, design, and the hard
 * platform constraint — and return structured findings + a verdict. The
 * orchestrator (claude-opus) synthesizes and applies the high-value fixes.
 *
 * Run from the quasar git root:
 *   git add workflows/quasar-tui-review-council.workflow.ts
 *   bun /Users/guilhermecastro/Projects/prism/src/cli.ts workflow run \
 *     workflows/quasar-tui-review-council.workflow.ts \
 *     --worker claude-code --permission permissive --max-concurrent-tasks 6 --task-timeout-ms 900000
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const BRIEF = `QUASAR TUI — review the BUILT implementation.

WHAT SHIPPED: a minimalist, power-user TUI for Quasar (a local cross-harness AI-session search + memory engine over 292 projects / 12,408 sessions / 659k messages across 7 harnesses). It is built with @opentui/react, compiled INTO the quasar CLI binary, launched as \`quasar tui\` (and bare \`quasar\` in a TTY).

DESIGN (committed from a prior product council): an "evidence browser / second-brain pager". Modeless, search-first. The ranked result list is the lived-in spine; the right pane previews the selected match, and Enter zooms it into a less-style session-transcript reader; \`t\` toggles tool-call forensics for that session; \`e\` hands off to \$EDITOR; \`y/Y\` yank. Filters live in the query language (project: provider: role:). Three focuses (search / list / reader), no vim normal/insert/visual modes. lexical is the instant default; m cycles lexical->semantic->fusion with a SILENT fallback to lexical + amber ~ when the index is reconciling.

THE SOURCE TO REVIEW (read these files):
- /Users/guilhermecastro/Projects/quasar/packages/cli/src/tui/app.tsx       (the screen: header, omnibox, result list, detail/reader/tools panes, keybar, help, all state + effects)
- /Users/guilhermecastro/Projects/quasar/packages/cli/src/tui/keymap.ts     (pure focus-aware key routing -> Intent; unit-tested)
- /Users/guilhermecastro/Projects/quasar/packages/cli/src/tui/quasar-client.ts (SYNC client; see the constraint below)
- /Users/guilhermecastro/Projects/quasar/packages/cli/src/tui/query.ts      (query-language filter parsing)
- /Users/guilhermecastro/Projects/quasar/packages/cli/src/tui/format.ts     (snippet, match ranges, windowing, relative time)
- /Users/guilhermecastro/Projects/quasar/packages/cli/src/tui/highlight.ts  (amber query-term highlighting via StyledText)
- /Users/guilhermecastro/Projects/quasar/packages/cli/src/tui/actions.ts    (clipboard yank, \$EDITOR temp-file handoff)
- /Users/guilhermecastro/Projects/quasar/packages/cli/src/tui/palette.ts    (warm-dark rig-derived palette)
- /Users/guilhermecastro/Projects/quasar/packages/cli/src/tui/entry.tsx     (renderer bootstrap + exit contract)
You may also read packages/cli/src/cli.ts (the \`tui\` command + bare-TTY launch) and the *.test.ts files.

THE HARD CONSTRAINT YOU MUST WEIGH (do not hand-wave): opentui's render loop runs continuously and STARVES libuv's poll phase, so in-process async \`fetch\` RESPONSE-BODY reads HANG under an active renderer (proven empirically: headers return in ~30ms, bodies never resolve; pause() does not help; not compile-specific). The fix shipped is SYNCHRONOUS I/O (spawnSync curl), which blocks the render loop for the call's duration instead of racing it — immune to the starvation. Consequence: each search/transcript-load briefly FREEZES the UI for the server's own latency (~0.4s warm lexical; multiple seconds cold or while the vector index is reconciling). Searches are debounced (200ms) so this is a "search-on-pause" freeze, not per-keystroke.

YOUR JOB: a rigorous, adversarial review. Be specific and cite file:line where you can. Cover:
1. CORRECTNESS — real bugs, race conditions, edge cases (empty results, huge transcripts, not-ready index, unconfigured server, focus transitions, the match-hop refs, the editor handoff). Default to skeptical.
2. UX / INTERACTION — does the evidence-browser model actually work? focus model, keybindings, the search/list/reader flow, the not-ready handling. What feels wrong for an elite power user?
3. LAYOUT / VISUAL — density, the result row (2-line meta+snippet), highlighting, provenance, the keybar, chrome. What should change?
4. THE SYNC-I/O TRADEOFF — is the synchronous-freeze acceptable for v1? Is there a BETTER fix you can justify (Worker thread for I/O? render-on-demand? search-on-enter vs as-you-type? a loading affordance)? Be concrete and weigh complexity.
5. SCOPE — what is MISSING that v1 genuinely needs, and what should be CUT as over-build.

Return ONLY JSON matching the output schema.`;

const Finding = Schema.Struct({
  severity: Schema.Literal("blocker", "high", "medium", "low", "nit"),
  area: Schema.Literal("correctness", "ux", "layout", "sync-io", "scope", "code-quality"),
  what: Schema.String,
  where: Schema.optional(Schema.String),
  fix: Schema.String,
});

const ReviewLens = Schema.Struct({
  worker: Schema.String,
  lens: Schema.String,
  verdict: Schema.Literal("ship", "ship-with-fixes", "needs-work"),
  headline: Schema.String,
  strengths: Schema.Array(Schema.String),
  findings: Schema.Array(Finding),
  syncIoVerdict: Schema.String,
  missingForV1: Schema.Array(Schema.String),
  cutForV1: Schema.Array(Schema.String),
  dissent: Schema.optional(Schema.String),
});

const reviewTask = (
  id: string,
  worker: "grok" | "kimi-code" | "opencode" | "antigravity-cli",
  model: string,
  lens: string,
) =>
  defineTask({
    id,
    agent: agents.forge.explorer,
    worker: { worker, model },
    output: ReviewLens,
    cacheKey: `quasar-tui-review/${id}/v1`,
    prompt: `${BRIEF}

YOUR LENS (${id}): ${lens}

Go DEEP on your lens but flag anything serious you see anywhere. READ THE ACTUAL SOURCE FILES before judging — findings without file evidence carry less weight. Set worker="${worker}". Return ONLY JSON matching the schema.`,
  });

const CORRECTNESS =
  "Correctness + reliability. Own dimension #1. Read app.tsx and keymap.ts closely. Hunt real bugs: the debounce/search effect, the match-hop refs (matchRefs/scrollChildIntoView), focus transitions, the sync transcript/tools loads freezing the UI, the editor handoff, not-ready fallback, empty/huge inputs, the liveRef staleness pattern. Be adversarial; default findings to real until you've ruled them out.";

const UX_INTERACTION =
  "UX + interaction model. Own dimension #2. Is the modeless evidence-browser (search/list/reader focuses, vim-flavored list keys, search-on-pause) actually good for an elite power user over 659k messages? Critique the keymap, focus flow, the not-ready amber-~ handling, the help surface, and whether Enter/Tab/Esc semantics are right. What would frustrate a daily driver?";

const LAYOUT_VISUAL =
  "Layout + visual design. Own dimension #3. Critique the rendered screen: header, omnibox, the 38/62 split, the 2-line result rows (meta + truncated highlighted snippet), provenance density, the transcript/tools panes, the keybar, the rig warm-dark palette. What concrete layout/typography/color changes raise the quality bar? Run \`quasar-dev tui\` or read the components if you can.";

const SYNC_IO =
  "The sync-I/O architecture. Own dimension #4. Weigh the synchronous spawnSync(curl) decision HARD against the opentui async-starvation constraint. Is the UI freeze acceptable for v1? Propose and JUSTIFY a better approach if one exists (Worker-thread I/O with message-passing, render-on-demand/auto() mode, search-on-enter instead of as-you-type, an explicit loading state, curl timeout tuning) — with a real complexity/benefit call. Don't hand-wave; this is the deepest risk.";

export default defineWorkflow({
  name: "quasar-tui-review-council",
  run: (wf) =>
    Effect.gen(function* () {
      const safe = (task: ReturnType<typeof reviewTask>) =>
        wf.runTask(task).pipe(Effect.catchAll(() => Effect.succeed(null)));

      const [grok, antigravity, kimi, opencode] = yield* Effect.all(
        [
          safe(reviewTask("grok-correctness", "grok", "grok-build", CORRECTNESS)),
          safe(reviewTask("agy-layout-visual", "antigravity-cli", "gpt-5.4-mini", LAYOUT_VISUAL)),
          safe(reviewTask("kimi-ux-interaction", "kimi-code", "kimi-code/kimi-for-coding", UX_INTERACTION)),
          safe(reviewTask("opencode-sync-io", "opencode", "synthetic/hf:moonshotai/Kimi-K2.6", SYNC_IO)),
        ],
        { concurrency: "unbounded" },
      );

      return { grok, antigravity, kimi, opencode };
    }),
});
