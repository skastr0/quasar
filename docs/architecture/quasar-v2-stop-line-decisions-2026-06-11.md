# Quasar v2 Stop-Line Decisions

> **HISTORICAL (resolved 2026-06-11).** The owner resolved this packet by replacing
> the entire framing in writing rather than approving either option: the
> [data-reality plan](quasar-data-reality-plan-2026-06-11.md) retires byte gates and
> invented budgets wholesale. Decision 1's substance survives as the single-carry
> tool-event mapping rule; Decision 2's substance becomes a simple bounded
> retry/backoff on `TooManyWrites` (the full estate is ~4 minutes of writes, so the
> 4 MiB/s boundary is a non-event at sequential pace). QSR-043/044 were abandoned
> with provenance; the replacement sequence is QSR-053..062.

Date: 2026-06-11
Status: historical — resolved by replacement in writing (owner order).

Two v2 beachhead glyphs have halted on measured gates. This document is the
decision packet, not the decision itself.

## Decision 1: Sync Contract Tool Event Shape

Measured in the contract harness on a real Claude sample:

- useful text bytes: `355,452`
- serialized envelope bytes: `501,388`
- amplification: `1.411x`
- maximum record overhead: `174` bytes

The sample gate is `<=1.3x`, and the escalation threshold is `>1.4x`. This is
not a server limit; it is the contract shape failing its own sample gate.

Recommended approval:

> Tool calls and tool results are represented only as `tc` records anchored by
> event sequence `q`. The contract must not also emit separate `msg` rows for
> those tool events. Session reads interleave tool calls by `tc.q`; text search
> indexes tool payload once from `tc.x`. The frozen denominator does not change.

Rejected options:

- Shrink tool input/output caps to pass the sample gate. That cuts product
  fidelity and violates the frozen denominator rule.
- Raise the sample gate. The measured floor is already above the escalation
  threshold, so changing only the number would hide a shape failure.
- Keep both message gloss rows and tool-call payload rows. That double-carries
  tool events and preserves the measured failure.

## Decision 2: Convex Write-Rate Boundary

Measured in the platform probe against the pinned self-hosted backend:

- inserted before rejection: `140` storage probe docs
- useful text inserted before rejection: `9,175,040` bytes
- backend data directory after rejection: `14,143,188` bytes
- rejection: `TooManyWrites`
- backend message: `Your deployment is limited to 4 MiB bytes written per 1
  second. Reduce your write rate or upgrade to a larger deployment.`

This is a Convex rejection, so QSR-043 halted. The next implementation must not
paper over it with an ad hoc sleep.

Official Convex docs confirm this is a deployment-class throughput boundary:
S16 has a `4 MiB` mutation write-throughput limit, S256 has `8 MiB`, and D1024
has `32 MiB`. The same docs keep per-transaction data-written at `16 MiB`, so
the observed failure is the per-second write-throughput wall, not the per-
transaction document-size wall. Convex's write guidance also points to measuring
document sizes and using transaction metrics to break work into bounded
transactions.

Recommended approval:

> Treat `4 MiB/s` backend writes as a first-class ingest budget. The sync runner
> and server write path must shape work to a documented write-rate budget before
> full-corpus ingest exists. Re-running the at-rest multiplier probe with that
> budget is allowed because the rate limit is then part of the approved product
> shape, not a workaround.

Concrete consequences:

- Keep the `512 KiB` transport envelope cap.
- Keep Convex mutation chunks around the already-planned `200-400` record band,
  but additionally meter aggregate write bytes per second.
- Server acknowledgements may expose `backpressureMs`; the local runner must
  honor it and checkpoint only digest-verified applied chunks.
- The server write path should estimate/write-count bytes and use
  `ctx.meta.getTransactionMetrics()` to stop before local transaction headroom
  is exhausted.
- The at-rest storage multiplier gate remains about bytes stored versus useful
  text. It is not allowed to pass by inserting fewer useful bytes.

Rejected options:

- Add sleeps only inside the probe. That would make the probe pass while leaving
  the ingest product unshaped.
- Increase concurrency or loosen Convex knobs. The measured failure is a write
  throughput limit, not a lack of parallelism.
- Switch backends now. The kill criteria name a backend swap only after a
  storage/cost/search failure; this measurement is a write-rate boundary that
  the existing plan can absorb if it becomes an explicit contract.

## Commit Rule

No QSR-043 or QSR-044 implementation commit should land until these decisions
are approved or replaced in writing.
