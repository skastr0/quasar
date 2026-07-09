# Local observability sink (grafana/otel-lgtm)

Opt-in OTLP collector + Grafana LGTM stack for the Quasar local server.
**Off by default.** Enabling requires two explicit envs and no product code change.

## Decision

| Choice | Verdict |
| --- | --- |
| Sink | `grafana/otel-lgtm` (collector + Grafana + Tempo + Mimir/Prometheus + Loki in one container) |
| Default | **off** — production deploy does not pull or start the sink |
| Enable | `COMPOSE_PROFILES=otel` **and** `QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318` |
| Server export | `QUASAR_OTLP_BASE_URL` — empty ⇒ no OTLP layer; set ⇒ `Otlp.layerJson` to that base |
| In-process watch | `/status` always embeds Effect `Metric.snapshot` (works with OTLP off) |

Rejected for this phase: always-on metrics stack; NodeSdk-first exporters; inventing a second export path beyond Effect `Otlp.layerJson`; auto-filling OTLP from any non-empty `COMPOSE_PROFILES` (bash `${VAR:+url}` is not a profile-token check).

## Enable

From the repo root, with `platform/server/.env` already configured:

```bash
COMPOSE_PROFILES=otel QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318 bun run server:deploy
# or without rebuild:
COMPOSE_PROFILES=otel QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318 bun run server:up
```

Persistent enable: uncomment **both** in `platform/server/.env`:

```bash
COMPOSE_PROFILES=otel
QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318
```

| Env | Role |
| --- | --- |
| `COMPOSE_PROFILES=otel` | Starts the profiled `otel-lgtm` service |
| `QUASAR_OTLP_BASE_URL=…` | Server process exports OTLP (empty = Layer.empty) |

Profile alone starts a collector nothing talks to. OTLP alone points the server at a URL with no in-compose sink. Both are required for the full path.

Disable: remove both from the environment / `.env` and `bun run server:deploy`.

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

- `packages/server/src/runtime.ts` gates on `QUASAR_OTLP_BASE_URL`: unset/empty → `Layer.empty`; set → `Otlp.layerJson({ baseUrl, resource: { serviceName: "quasar-server" } })`.
- Compose never invents that URL from `COMPOSE_PROFILES`. Set `QUASAR_OTLP_BASE_URL` explicitly (in-network default: `http://otel-lgtm:4318`).
- `/status` still returns the local metric snapshot + healthy envelope + alert rule definitions whether or not the sink is running.

## Operator check (live stack)

When the sink image is available locally:

```bash
COMPOSE_PROFILES=otel QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318 bun run server:deploy
# wait until Grafana answers
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
# exercise a fusion query against the published API, then in Grafana:
#   Explore → Tempo → search serviceName=quasar-server
#   Explore → Prometheus → quasar.* series
bun run server:status   # local snapshot still present without scraping the sink
```

Unit-level smoke (no container pull required if `docker compose config` is available):
`packages/server/test/ops-config.test.ts` and `packages/server/test/observability.test.ts`.

Live fusion-trace + watermark-gauge screenshot in Grafana is an **operator** check when `grafana/otel-lgtm` is pulled; CI does not require the multi-GB image and does not claim that screenshot as a CI receipt.

## Compose config smoke

```bash
# profile off — otel-lgtm absent, OTLP empty
docker compose --env-file platform/server/.env -f platform/server/compose.yaml config \
  | grep -E 'otel-lgtm|QUASAR_OTLP_BASE_URL' || true

# profile on alone — sink present, OTLP still empty (must set base URL)
COMPOSE_PROFILES=otel docker compose --env-file platform/server/.env \
  -f platform/server/compose.yaml config \
  | grep -E 'otel-lgtm|QUASAR_OTLP_BASE_URL|profiles'

# full enable — sink + wired export
COMPOSE_PROFILES=otel QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318 \
  docker compose --env-file platform/server/.env -f platform/server/compose.yaml config \
  | grep -E 'otel-lgtm|QUASAR_OTLP_BASE_URL'
```
