# Local observability sink (grafana/otel-lgtm)

Opt-in OTLP collector + Grafana LGTM stack for the Quasar local server.
**Off by default.** Enabling requires exactly one env flag and no product code change.

## Decision

| Choice | Verdict |
| --- | --- |
| Sink | `grafana/otel-lgtm` (collector + Grafana + Tempo + Mimir/Prometheus + Loki in one container) |
| Default | **off** — production deploy does not pull or start the sink |
| Enable | **one env:** `COMPOSE_PROFILES=otel` |
| Server export | `QUASAR_OTLP_BASE_URL` — empty ⇒ no OTLP layer; profile-on defaults to `http://otel-lgtm:4318` |
| In-process watch | `/status` always embeds Effect `Metric.snapshot` (works with OTLP off) |

Rejected for this phase: always-on metrics stack; NodeSdk-first exporters; inventing a second export path beyond Effect `Otlp.layerJson`.

## Enable (one flag)

From the repo root, with `platform/server/.env` already configured:

```bash
COMPOSE_PROFILES=otel bun run server:deploy
# or without rebuild:
COMPOSE_PROFILES=otel bun run server:up
```

Persistent enable: uncomment `COMPOSE_PROFILES=otel` in `platform/server/.env`.

Disable: unset `COMPOSE_PROFILES` (or remove it from `.env`) and `bun run server:deploy`.

Override OTLP target without code changes:

```bash
COMPOSE_PROFILES=otel QUASAR_OTLP_BASE_URL=http://other-collector:4318 bun run server:up
```

## Expected Grafana path

| Surface | URL / path |
| --- | --- |
| Grafana UI | http://localhost:3000 (default host port; override `QUASAR_OTEL_GRAFANA_PORT`) |
| Login | `admin` / `admin` (change on first login if prompted) |
| Traces | Explore → **Tempo** → service `quasar-server` → stage spans (`search.fusion`, `ingest.session`, …) |
| Metrics | Explore → **Prometheus** / Mimir → series under `quasar.*` (search timers, queue gauges, `quasar.vector_matrix.watermark_drift`, …) |
| Logs | Explore → **Loki** → JSON logs from Effect `Logger.json` when OTLP is on |
| Host OTLP/HTTP | `localhost:4318` (override `QUASAR_OTEL_OTLP_HTTP_PORT`; in-compose traffic uses `otel-lgtm:4318`) |

Compose service name: `otel-lgtm`. Image: `grafana/otel-lgtm:latest`.

## Server contract (no code change to enable)

- `packages/server/src/runtime.ts` already gates on `QUASAR_OTLP_BASE_URL`: unset/empty → `Layer.empty`; set → `Otlp.layerJson({ baseUrl, resource: { serviceName: "quasar-server" } })`.
- Compose wires that env when `COMPOSE_PROFILES` is non-empty (default base `http://otel-lgtm:4318`).
- `/status` still returns the local metric snapshot + healthy envelope + alert rule definitions whether or not the sink is running.

## E2E receipt (operator)

When the sink image is available locally:

```bash
COMPOSE_PROFILES=otel bun run server:deploy
# wait until Grafana answers
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
# exercise a fusion query against the published API, then in Grafana:
#   Explore → Tempo → search serviceName=quasar-server
#   Explore → Prometheus → quasar_vector_matrix_watermark_drift (or quasar.* after rename)
bun run server:status   # local snapshot still present without scraping the sink
```

Unit-level smoke (no container): compose config + OTLP env gate tests in
`packages/server/test/ops-config.test.ts` and `packages/server/test/observability.test.ts`.

Full live fusion-trace + watermark-gauge screenshot in Grafana is an operator
receipt when `grafana/otel-lgtm` is pulled; CI does not require the multi-GB image.

## Compose config smoke

```bash
# profile off — otel-lgtm absent, OTLP empty
docker compose --env-file platform/server/.env -f platform/server/compose.yaml config \
  | grep -E 'otel-lgtm|QUASAR_OTLP_BASE_URL' || true

# profile on — service present, OTLP defaults to in-network collector
COMPOSE_PROFILES=otel docker compose --env-file platform/server/.env \
  -f platform/server/compose.yaml config \
  | grep -E 'otel-lgtm|QUASAR_OTLP_BASE_URL|profiles'
```
