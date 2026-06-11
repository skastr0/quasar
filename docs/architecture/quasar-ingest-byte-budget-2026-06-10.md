> [!IMPORTANT]
> **Historical document — superseded 2026-06-10.** This report measured the abandoned
> record-stream compaction era. Its gate (a 1.5x wire ratio whose denominator excluded
> tool payloads) was diagnosed as structurally unreachable in that record shape, and the
> compaction direction it mandates was abandoned. **Every instruction in this document is
> superseded — including the "Required Follow-Up" and all verdicts.** The measurement
> methodology (field-level byte attribution) survives and is re-instituted with a frozen
> product-derived denominator. The single current direction is
> [Quasar v2 — Canonical Greenfield Plan](quasar-v2-greenfield-plan-2026-06-10.md).

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

## Follow-Up Measurements

### QSR-025 Corrected Baseline

After preserving structured and metadata-bearing content blocks, the corrected
post-QSR-025 full-machine dry-run still failed the gate.

| Metric | Value |
| --- | ---: |
| Envelope wire bytes | 1,842,743,597 |
| Useful text bytes | 554,158,295 |
| Amplification ratio | 3.325x |
| RSS high-water bytes | 3,292,758,016 |
| Event wire bytes | 742,508,464 |
| Content block wire bytes | 724,956,088 |
| Tool call wire bytes | 241,602,587 |
| Usage wire bytes | 74,652,834 |
| Edge wire bytes | 55,096,588 |

### QSR-026 Latest-Tree Rerun

QSR-026 made the canonical projection leaner:

- Derivable text/markdown/thinking fields are omitted from semantic content
  block records when the owning event already carries the same `contentText`.
- Chronological reads materialize those fields from the event.
- Large projected tool payloads are replaced with deterministic
  truncated/hash/preview markers.
- Default dry-runs use a temporary disk SQLite ledger instead of a process-memory
  ledger.

The latest full-machine dry-run completed successfully at
`2026-06-10T07:51:40.982Z` with no live writes.

| Metric | Value |
| --- | ---: |
| Files processed | 612 |
| Records sent | 1,255,085 |
| Envelopes sent | 6,626 |
| Record wire bytes | 1,411,357,097 |
| Envelope wire bytes | 1,413,659,090 |
| Useful text bytes | 386,379,384 |
| Pruned bytes estimate | 307,915,884 |
| Amplification ratio | 3.659x |
| Max record bytes | 32,768 |
| p95 record bytes | 2,245 |
| RSS high-water bytes | 2,424,537,088 |
| Elapsed milliseconds | 777,442 |

| Record type | Count | Wire bytes |
| --- | ---: | ---: |
| source_root | 8 | 1,871 |
| session | 1,565 | 1,621,747 |
| event | 451,368 | 743,193,470 |
| content_block | 527,279 | 394,208,049 |
| tool_call | 83,427 | 142,233,353 |
| usage | 112,704 | 74,763,456 |
| edge | 78,724 | 55,324,746 |
| artifact | 10 | 10,405 |

Field-level measurement after QSR-026 showed the remaining bulk is no longer
primarily oversized payload text:

| Contributor | Bytes |
| --- | ---: |
| Event `contentText` | 376,344,855 |
| Event ids/identity fields | 163,641,740 |
| Event `rawReference` | 85,153,470 |
| Content block ids/identity fields | 216,545,260 |
| Content block text fields | 74,779,169 |
| Content block metadata | 23,816,087 |
| Tool input payloads | 19,286,973 |
| Tool output payloads | 65,858,087 |

Verdict: QSR-026 materially improved the corrected baseline, but the byte gate
still fails. Envelope bytes dropped from about 1.84GB to about 1.41GB and RSS
dropped from about 3.29GB to about 2.42GB, but amplification remains 3.659x
against the 1.5x target and RSS is still not flat.

The next follow-up must address repeated identity/evidence/storage shape. Event
records alone now exceed the target envelope size implied by current useful-text
bytes, so another payload clamp cannot pass the gate. Do not run live ingest
until that storage-shape follow-up lands and this report is rerun.

### QSR-027 Latest-Tree Rerun

QSR-027 compacted derivable child identity and per-event source evidence:

- Session records remain the identity anchor.
- Event, content block, tool call, usage, artifact, and edge records no longer
  carry session-derived machine/provider/agent/project identity fields.
- Event records keep compact evidence such as line/native type, while source
  path is derived from the session.
- Convex materializes stored/indexed child identity from the existing parent
  session or event in the single record write path.
- Compact child records fail closed if their parent session/event is absent.
- The decoder rejects legacy child identity fields before schema decode can
  normalize them away.

The latest full-machine dry-run completed successfully at
`2026-06-10T08:16:49.153Z` with no live writes.

| Metric | Value |
| --- | ---: |
| Files processed | 612 |
| Records sent | 1,259,704 |
| Envelopes sent | 6,647 |
| Record wire bytes | 1,057,113,049 |
| Envelope wire bytes | 1,059,422,979 |
| Useful text bytes | 387,616,813 |
| Pruned bytes estimate | 664,964,701 |
| Amplification ratio | 2.733x |
| Max record bytes | 32,768 |
| p95 record bytes | 1,972 |
| RSS high-water bytes | 1,563,082,752 |
| Elapsed milliseconds | 741,139 |

| Record type | Count | Wire bytes |
| --- | ---: | ---: |
| source_root | 8 | 1,871 |
| session | 1,565 | 1,621,757 |
| event | 453,060 | 595,461,570 |
| content_block | 528,908 | 241,045,693 |
| tool_call | 83,845 | 126,307,072 |
| usage | 112,982 | 52,660,694 |
| edge | 79,326 | 40,005,987 |
| artifact | 10 | 8,405 |

Field-level attribution after QSR-027:

| Contributor | Bytes |
| --- | ---: |
| Event `contentText` | 377,687,284 |
| Event ids/reference fields | 100,773,360 |
| Event compact evidence | 24,084,041 |
| Content block ids/reference fields | 98,975,610 |
| Content block text fields | 74,875,689 |
| Content block metadata | 23,921,253 |
| Tool input payloads | 19,398,203 |
| Tool output payloads | 66,191,324 |
| Tool ids/reference fields | 25,431,451 |
| Usage ids/reference fields | 31,304,286 |

Verdict: QSR-027 materially improved QSR-026, but the byte gate still fails.
Envelope bytes dropped from about 1.41GB to about 1.06GB and RSS dropped from
about 2.42GB to about 1.56GB. Amplification remains 2.733x against the 1.5x
target, and RSS is still not in the few-hundred-MB band.

The remaining blocker is no longer derivable identity alone. Event
`contentText` is the necessary search narrative, and event records alone are
near the target envelope size. The next follow-up must decide what non-search
detail belongs in live server storage before QSR-023: content block sidecars,
tool payload bodies, usage detail, and edge detail cannot all remain live
records at their current fidelity and still meet the measured budget.
