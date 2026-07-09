# Pulsar Observer baseline — 2026-07-08 (pre-refactor reference)

Reference point for the QSR-258..261 adapter-refactor arc and the QSR-254..257
observability arc. Compare future runs against this file; the raw machine-readable
output is `pulsar-baseline-2026-07-08.json` next to it.

- Repo: quasar @ `b9d227e2ecc297b5fb2b8f29d36c69f298e8cca0` (v0.3.4)
- Pulsar: v0.1.2, vector `all-defaults` (built-in), AI mode inactive
- Reproduce: `pulsar score --json --no-progress` (full observer) ·
  `pulsar score --signal <id> --no-progress` (per-signal diagnostics)

## Verdict

| measure | value |
|---|---|
| Readiness | **0.279 — red**, pressure 0.721, driver `local_poison` |
| Hard gate | **PASS** |
| Evidence mean | 0.778 |
| Weighted mean | 0.588 |
| Signals | 32 applicable / 16 ignored / 0 failed |

## Categories

| category | score |
|---|---|
| architectural-drift | **0.279** |
| review-pain | 0.388 (campaign churn Jul 4–7; expected to decay) |
| legibility-decay | 0.444 |
| concurrency-safety | 0.580 |
| generated-slop | 0.658 |
| security-risk | 0.664 |
| abstraction-bloat | 0.725 |
| dependency-entropy | 0.883 |
| behavior-preservation | 1.000 |

## Top pressures (signal / score / poison authority)

1. `TS-LD-02-function-size-distribution` 0.183
2. `TS-AD-04-boundary-parser-coverage` 0.259 **(poison)**
3. `SHARED-03-churn-rate` 0.264 (campaign residue)
4. `TS-LD-01-cyclomatic-complexity` 0.364
5. `TS-SL-02-inconsistent-clones` 0.466
6. `TS-CC-01-async-failure-control` 0.500 **(poison)**
7. `TS-LD-09-error-channel-opacity` 0.507
8. `TS-AD-05-boundary-trust-breach` 0.500
9. `TS-RP-01-hotspots` 0.525
10. `TS-AB-04-interface-implementation-ratio` 0.600

## Per-signal diagnostics (verbatim from single-signal runs)

### TS-AD-04-boundary-parser-coverage — 0.259 (10 diagnostics)

- WARN `rolesFromInvokeToolCall` accepts weak external input without parse/decode evidence — packages/cli/src/adapters/antigravity-schema.ts:325
- WARN `claudeMessageKind` — packages/cli/src/adapters/claude-schema.ts:454
- WARN `classifyClaudeRecord` — packages/cli/src/adapters/claude-schema.ts:610
- WARN `codexDiscriminatorOf` — packages/cli/src/adapters/codex-schema.ts:493
- WARN `classifyCodexRecord` — packages/cli/src/adapters/codex-schema.ts:695
- WARN `numberValue` — packages/cli/src/adapters/common.ts:311
- WARN `scopedId` — packages/cli/src/adapters/common.ts:323
- WARN `jsonBlock` — packages/cli/src/adapters/common.ts:352
- WARN `contentBlocksFromNative` — packages/cli/src/adapters/common.ts:364
- WARN `edgeIdFor` — packages/cli/src/adapters/common.ts:539

Triage note (QSR-258 comment 2026-07-08): the classifier flags
(`classifyClaudeRecord`, `codexDiscriminatorOf`, `claudeMessageKind`, …) are the
fail-closed declarative dispatch working as designed — the `typeof` peek is
pre-decode discrimination, disposition (c) document-don't-rewrite. The
`common.ts` extractor flags point at the genuine fail-open substrate.

### TS-AD-05-boundary-trust-breach — 0.500 (7 diagnostics)

- WARN #1 packages/cli/src/adapters/antigravity-schema.ts (score=0.54)
- WARN #2 packages/cli/src/adapters/claude-schema.ts (0.54)
- WARN #3 packages/cli/src/adapters/codex-schema.ts (0.54)
- WARN #4 packages/cli/src/adapters/grok-schema.ts (0.54)
- WARN #5 packages/cli/src/adapters/grok.ts (0.54)
- WARN #6 packages/cli/src/adapters/opencode-schema.ts (0.54)
- INFO #7 packages/cli/src/adapters/common.ts (0.27)

### TS-LD-09-error-channel-opacity — 0.507 (10 diagnostics)

- WARN catch fallback hides error channel in boundary `readJsonFile` — packages/cli/src/adapters/common.ts:150
- WARN `compactText` — packages/cli/src/adapters/common.ts:291
- WARN `loadMachineIdentity` — packages/cli/src/core/machine.ts:22
- WARN `loadManifest` — packages/cli/src/ingest.ts:37
- WARN `loadNativeSimsimd` — packages/server/src/vectorKernel.ts:218
- WARN broad throw in boundary `postMappedSession` — packages/cli/src/ingest.ts:232
- INFO `readWorkdirFromConversationDb` — packages/cli/src/adapters/antigravity.ts:196
- INFO `buildLineageMap` — packages/cli/src/adapters/antigravity.ts:273
- INFO `streamAntigravity` — packages/cli/src/adapters/antigravity.ts:552
- INFO `visit` — packages/cli/src/adapters/codex.ts:815

### TS-CC-01-async-failure-control — 0.500 (5 diagnostics)

- WARN floating-promise — packages/cli/scripts/tui-snapshot.tsx:42
- WARN floating-promise — packages/cli/scripts/tui-snapshot.tsx:43
- WARN floating-promise — packages/cli/scripts/tui-snapshot.tsx:47
- WARN fire-and-forget — packages/cli/src/tui/app.tsx:413
- WARN fire-and-forget — packages/cli/src/tui/app.tsx:426

Constraint on record: the TUI deliberately avoids awaited in-process async under
an active opentui renderer (render loop starves libuv poll). Fix is explicit
failure routing, not naive awaiting (QSR-260).

### TS-SL-02-inconsistent-clones — 0.466 (7 groups)

- WARN `chunksOf` (packages/server/src/embeddings.ts:149) ≡ `chunked` (packages/server/src/store.ts:933)
- WARN `copyDatabaseForRead` (packages/cli/src/adapters/antigravity.ts:142) ≡ (packages/cli/src/adapters/opencode.ts:879)
- INFO workflows/*.workflow.ts groups (mustReview/reviewerAgent/mustBeReady × 2 files) — dev orchestration scripts, out of refactor scope
- INFO `toolCall`/`ingestRun` Effect.gen pair — packages/server/src/server.ts:281/:303
- INFO `partsContentText` ≡ `partsReasoningText` — packages/cli/src/adapters/opencode.ts:464/:486

### TS-LD-02-function-size-distribution — 0.183 (repo minimum; top findings)

- WARN `buildAgentSession` 273 LOC — packages/cli/src/adapters/kimi.ts:259
- WARN `streamCodex` 137 LOC — packages/cli/src/adapters/codex.ts:1073
- WARN `buildAntigravitySession` 132 LOC — packages/cli/src/adapters/antigravity.ts:285
- WARN `streamAntigravity` 132 LOC — packages/cli/src/adapters/antigravity.ts:509
- WARN `streamOpenCode` 132 LOC — packages/cli/src/adapters/opencode.ts:980

## Interpretation of record

Pressure concentrates in the CLI adapter estate (the ingest boundary); the
server is comparatively clean (three minor hits). Two-layer diagnosis on
QSR-258: fail-closed record dispatch (good, keep) over a fail-open file/field
substrate (the genuine contract breach). The score is the ratchet, never the
target: fixes are specified by the QSR-258/259/260/261 glyphs, and improvement
is verified per-slice with `pulsar score --signal <id>`, full observer at arc
end, compared against this file. Baseline-set for CI ratcheting happens only
AFTER the arc lands (QSR-239 comment 2026-07-08).
