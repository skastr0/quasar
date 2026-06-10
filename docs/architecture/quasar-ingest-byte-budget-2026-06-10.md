# Quasar Ingest Byte Budget Report - 2026-06-10

## Verdict

The full-machine dry-run gate failed.

- Record size: pass. The maximum normalized record hit the hard 32 KiB cap and p95 was 3,869 bytes.
- RSS: fail. High-water RSS was 3,303,292,928 bytes, about 3.08 GiB, not a few hundred MB.
- Amplification: fail. Envelope wire bytes divided by useful text bytes was 3.826x, above the 1.5x target.
- Live writes: pass. The measured command used `dryRun: true`; the reported server counts are dry-run sender accounting, not Convex writes.

No live ingest may run until a follow-up glyph reduces amplification and memory, then this gate is rerun.

## Commands

Baseline validation on the post-QSR-024 tree:

```sh
bun run --cwd packages/core typecheck
bun run --cwd packages/core test
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli test
bun run --cwd apps/control typecheck
bun run --cwd apps/control test
```

All baseline commands passed.

Dry-run command:

```sh
bun run --cwd packages/cli dev ingest '{"dryRun":true}'
```

The run completed successfully at `2026-06-10T06:02:22.810Z` after 975,860 ms.

## File Counts

| Metric | Count |
| --- | ---: |
| Files discovered | 603 |
| Files processed | 603 |
| Files skipped | 0 |
| Incomplete files | 0 |
| Removed files | 0 |
| Unconfirmed missing files | 0 |

## Record Counts And Wire Bytes

| Record type | Count | Wire bytes |
| --- | ---: | ---: |
| source_root | 8 | 1,871 |
| session | 1,556 | 1,613,269 |
| event | 447,647 | 739,023,889 |
| content_block | 523,738 | 722,440,226 |
| tool_call | 82,534 | 240,262,709 |
| usage | 112,184 | 74,422,810 |
| edge | 523,771 | 333,444,167 |
| artifact | 10 | 10,405 |
| Total records | 1,691,448 | 2,111,219,346 |

Envelope count: 8,814.
Envelope wire bytes: 2,114,303,406.

## Byte Metrics

| Metric | Bytes | Approx |
| --- | ---: | ---: |
| Source bytes | 1,715,136,794 | 1,635.68 MiB |
| Record wire bytes | 2,111,219,346 | 2,013.42 MiB |
| Envelope wire bytes | 2,114,303,406 | 2,016.36 MiB |
| Useful text bytes | 552,570,412 | 526.97 MiB |
| Pruned bytes estimate | 0 | 0 MiB |
| Max record bytes | 32,768 | 32.00 KiB |
| p95 record bytes | 3,869 | 3.78 KiB |
| RSS high-water bytes | 3,303,292,928 | 3.08 GiB |

Amplification ratio: `2,114,303,406 / 552,570,412 = 3.8263058609080938`.

## Provider Diagnostics

| Provider | Adapter | Status | Root | Message |
| --- | --- | --- | --- | --- |
| codex | codex-local-jsonl | available | `/Users/guilhermecastro/.codex/sessions` | Discovered 524 Codex source units; processed 524; skipped 0. |
| claude | claude-code-project-jsonl | available | `/Users/guilhermecastro/.claude/projects` | Discovered 67 Claude sessions. |
| opencode | opencode-sqlite | available | `/Users/guilhermecastro/.local/share/opencode/opencode-local.db` | Discovered 881 OpenCode sessions. |
| grok | grok-session-folder | available | `/Users/guilhermecastro/.grok/sessions` | Discovered 10 Grok sessions. |
| hermes | hermes-state-sqlite | available | `/Users/guilhermecastro/.hermes/state.db` | Discovered 74 Hermes sessions. |
| amp | amp-local-threads | no_data_found | `/Users/guilhermecastro/.local/share/amp` | Discovered 0 Amp sessions; skipped `secrets.json`. |
| pi | pi-local-json-tree | no_data_found | `/Users/guilhermecastro/.pi/agent/sessions` | Pi root was not found. |
| kimi | kimi-local-wire | no_data_found | `/Users/guilhermecastro/.kimi-code` | Discovered 0 Kimi sessions. |
| droid | factory-droid-local-captures | no_data_found | `/Users/guilhermecastro/.factory` | Discovered 0 Factory/Droid captures. |
| antigravity | antigravity-local-transcripts | no_data_found | `/Users/guilhermecastro/.gemini/antigravity` | Antigravity root was not found. |
| cursor | cursor-sqlite-copied | no_data_found | `/Users/guilhermecastro/Library/Application Support/Cursor/User` | Cursor User storage root was not found. |

## Diagnosis

The known duplicate-text issue is real but not sufficient to explain the miss.

- `event` records account for 739,023,889 bytes, about 35.0 percent of record wire.
- `content_block` records account for 722,440,226 bytes, about 34.2 percent of record wire.
- `edge` records account for 333,444,167 bytes, about 15.8 percent of record wire.
- `tool_call` records account for 240,262,709 bytes, about 11.4 percent of record wire.

If every content_block byte disappeared, the amplification ratio would still be about 2.519x. If content_block and edge bytes both disappeared, the ratio would still be about 1.915x. The follow-up therefore cannot be a cosmetic duplicate-text fix only.

The RSS failure is independent of the server storage budget: a 603-file dry-run peaked at about 3.08 GiB. That must be reduced before the live ingest proof.

## Duplicate-Text Decision

Decision: do not accept a 2x duplicate-text budget.

The measured ratio is 3.826x, and the duplicate content-block category is only one contributor. Quasar should suppress content-block records whose only value is a duplicate of `event.contentText`, then synthesize those blocks at read time when the chronological view needs them. Native structured content blocks that add information beyond `event.contentText` should remain records.

Because the post-suppression estimate is still above 1.5x, the follow-up must also reduce non-semantic graph/metadata amplification and RSS before live writes.

## Required Follow-Up

Create and complete a Forge follow-up before QSR-023:

- Suppress duplicate text-only content_block records and synthesize them from events at read time.
- Revisit default session edge emission. The dry-run produced 523,771 edge records; default `next` edges are derivable from event sequence and should not be stored if they only repeat ordering.
- Keep parent/tool-result edges only when they carry non-derivable structure.
- Reduce dry-run memory high-water materially; the pass target is a stable sub-GiB bound, with a preference for a few hundred MB.
- Rerun the full dry-run and update this report before any live server writes.
