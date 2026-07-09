# Observability sink decision + watchdog rescope

Recorded for the local server observability arc (Effect logger/spans/metrics +
optional OTLP sink). Board work items for this decision live in Tower (forge);
this file is the durable product note — no runtime code depends on it.

## Sink decision (locked)

**grafana/otel-lgtm as an opt-in Docker Compose profile.**

- **Default:** off. A normal `bun run server:deploy` does not start a metrics UI
  or OTLP collector.
- **Enable (two envs):** `COMPOSE_PROFILES=otel` starts the sink;
  `QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318` wires server export (see
  `docs/operations/observability-sink.md`). Profile membership is not inferred
  from a non-empty `COMPOSE_PROFILES` string.
- **No product code change to enable.** The server already exports when
  `QUASAR_OTLP_BASE_URL` is set (`packages/server/src/runtime.ts`); compose does
  not invent that URL — set it explicitly for the in-network collector.
- **Why this sink:** one container, OTLP/HTTP native, local-first, matches
  Effect `@effect/opentelemetry` `Otlp.layerJson` (no NodeSdk, no extra SDK
  deps). Adequate for Mac mini operator watch; not a claim about multi-tenant
  production observability.

**Rejected:** always-on Prometheus/Grafana in the default compose path; building
a custom collector; requiring a code flag or rebuild to turn the sink on.

## Metric surface the sink (and watchdog) consume

The in-process Effect Metric surface (timers, gauges, counters, frequencies)
is the source of truth for live numbers. `/status` embeds:

- `Metric.snapshot` filtered to `quasar.*`
- stated healthy envelope (watermark drift, overwrite)
- alert rule definitions (bench gates: scan p95, embed p50/p95, warm total p95)

OTLP export (when enabled) is a fan-out of the same Effect metrics/spans/logs —
not a second instrumentation stack.

## Watchdog rescope (hardening arc)

The **watchdog stands** as a **separate process** that must survive server
death. Scope that still holds:

| Class | Intent |
| --- | --- |
| Search health | `/ready` + mode latency vs alert rules |
| Ingest freshness | age of newest session vs harness sources |
| Disk ratio | store size vs measured corpus reality |
| Embed parity | dead-letters + matrix/SQLite count parity (`watermark_drift`) |
| Heartbeat | daily “watchdog alive” so silence ≠ health |

**What changed:** the watchdog **reads the existing metric /status surface**
instead of growing its own probes for numbers the server already exposes. Probe
work shrinks to: poll `/status` (and `/ready`), compare against the shipped
alert rules / healthy envelope, plus the few checks that are inherently
out-of-process (disk on the host, harness file mtime, “is the server up at
all”).

### Supersession of “no metrics stack”

An earlier watchdog note **discarded** a Prometheus/Grafana metrics stack as
machinery the objective did not need, and correctly required alarms **outside**
the server process.

That discard is **superseded in part** by this arc:

| Prior discard | Now |
| --- | --- |
| No metrics stack at all | Opt-in local LGTM sink for humans debugging traces/metrics; still **off by default** |
| No always-on Grafana in the product path | Still true — profile must be enabled deliberately |
| Alarms must not live only inside the server | Still true — watchdog remains a separate process |
| Watchdog grows bespoke numeric probes | Superseded — consume `/status` metrics + alert rule definitions |

**Still discarded:** embedding a full metrics stack in the default deploy;
alarms that die when the server dies; auto-remediation.

## Pointers

- Enable + Grafana paths: `docs/operations/observability-sink.md`
- Compose: `platform/server/compose.yaml` (service `otel-lgtm`, profile `otel`)
- OTLP gate: `packages/server/src/runtime.ts` (`QUASAR_OTLP_BASE_URL`)
- Metric definitions: `packages/server/src/metrics.ts`
