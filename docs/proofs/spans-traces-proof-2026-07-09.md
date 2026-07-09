# Spans / traces / warm-p95 proof — 2026-07-09

Proof for forge work item **Observability 2** (stage-level `Effect.withSpan` on
search + ingest; `SearchReceipt.traceId` when profiling or OTLP is on).

## Verdict (this receipt)

| Claim | Status | Grounding |
| --- | --- | --- |
| Stage-level span names wired on search/ingest | **PASS (unit)** | `packages/server/test/observability.test.ts` extracts `Effect.withSpan("…")` from product sources and asserts the required set + matrix altitude |
| `SearchReceipt.traceId` when `QUASAR_SEARCH_PROFILE=1` | **PASS (HTTP)** | `packages/server/test/server.test.ts` — profile env + full local-API test |
| `SearchReceipt.traceId` when `QUASAR_OTLP_BASE_URL` set | **PASS (HTTP)** | same file — OTLP base URL alone enables receipt + non-empty `traceId` |
| Neither env → no receipt | **PASS (HTTP)** | same file — receipt omitted |
| Captured Tempo traces (fusion / degraded fusion / ingest) | **OPERATOR** | commands below; requires live sink + corpus |
| Warm p95 lexical/semantic/fusion &lt; 100ms post-instrumentation | **DEFERRED** | no live matrix + warm corpus bench in this repair session; re-receipt command below. Unit tests hold the span contract only. |

No p95 numbers are invented here. Historical pre-instrumentation CHANGELOG note
(0.3.0 cutover): warm p95 lexical/semantic/fusion **6 / 85 / 97 ms** — that is
**not** a post-span re-receipt.

## Span contract (product wiring)

Parent route spans (HTTP handlers in `packages/server/src/server.ts`):

- `search.lexical`
- `search.semantic`
- `search.fusion`

Stage legs:

| Span | File |
| --- | --- |
| `search.lexicalScan` | `packages/server/src/search.ts` |
| `search.embedText` | `packages/server/src/embeddings.ts` |
| `search.matrixScan` | `packages/server/src/vectorMatrix.ts` (whole search effect — **not** the per-row mask loop) |
| `search.rrfFuse` | `packages/server/src/server.ts` |
| `search.readiness` | `packages/server/src/server.ts` |
| `ingest.session` | `packages/server/src/ingest.ts` |
| `ingest.diffApply` / `ingest.chunk` / plan-head-fingerprint | `packages/server/src/store.ts` |

Altitude rule: stage-level only. Instrumentation must not eat the 60ms matrix
scan p95 budget with per-row spans.

`SearchReceipt.traceId` ships when either:

- `QUASAR_SEARCH_PROFILE=1`, or
- `QUASAR_OTLP_BASE_URL` is non-empty (same gate as `Otlp.layerJson` in `runtime.ts`).

## Unit / integration tests that hold the contract

```bash
# From repo root
bun test packages/server/test/observability.test.ts
bun test packages/server/test/server.test.ts
# Or full server package:
bun run test packages/server
```

## Capture traces (operator)

Enable the opt-in sink (see `docs/operations/observability-sink.md`):

```bash
COMPOSE_PROFILES=otel QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318 bun run server:deploy
# wait until Grafana answers
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

Server URL: use the published Tailscale / compose port from
`docs/operations/server-docker-tailscale.md` (not a random localhost app).

### 1) Fusion query (all legs visible)

```bash
export QUASAR_SERVER_URL="${QUASAR_SERVER_URL:-http://127.0.0.1:7180}"
# Prefer OTLP on the server (already set via compose). Optional verbose receipts:
# QUASAR_SEARCH_PROFILE=1 on the server process also logs search.profile.

curl -fsS "${QUASAR_SERVER_URL}/search/fusion?q=quasar%20local%20server&limit=5" | jq .
# Expect: data.receipt.traceId (when OTLP or SEARCH_PROFILE on), legs under parent search.fusion
# In Grafana: Explore → Tempo → serviceName=quasar-server → search.fusion
#   children: search.readiness, search.lexicalScan, search.embedText, search.matrixScan, search.rrfFuse
```

### 2) Degraded fusion (lexical-only fallback + reason)

Force the semantic leg to fail while lexical still works (example: stop the
query embedder / point `QUASAR_QUERY_EMBEDDING_PROVIDER` at an unavailable path
on a non-prod scratch process — **do not** break production). Then:

```bash
curl -fsS "${QUASAR_SERVER_URL}/search/fusion?q=quasar%20local%20server&limit=5" | jq .
# Expect: data.degraded == true, data.degradedReason set, matches from lexical
# Tempo: search.fusion still present; semantic leg error annotated; rrfFuse runs on lexical-only
```

Hermetic alternative without a broken embedder: unit/HTTP paths already cover
the degraded branch in product tests; the operator capture is for Tempo shape.

### 3) Ingest tick applying a real session diff

```bash
# Authenticated session ingest (token from platform/server/.env)
curl -fsS -X POST "${QUASAR_SERVER_URL}/ingest/session" \
  -H "content-type: application/json" \
  -H "x-quasar-ingest-token: ${QUASAR_INGEST_TOKEN}" \
  -d @/path/to/mapped-session.json
# Or let the incremental sync LaunchAgent tick apply a changed session on disk.

# Tempo: serviceName=quasar-server → ingest.session
#   children: ingest.diffPlan / ingest.diffHead / ingest.chunk* / ingest.diffFingerprint / ingest.diffApply
```

## Warm p95 re-receipt (DEFERRED — run when live matrix is warm)

Gate from `packages/server/src/metrics.ts` alert rule `search.warm.total.p95`:
**warm end-to-end p95 &lt; 100ms** (semantic series; also compare lexical + fusion).

```bash
# Server must be warm (vector matrix loaded, query embed cache hot).
# Prefer production-like URL + SEARCH_PROFILE receipts for stage legs:
#   set QUASAR_SEARCH_PROFILE=1 on the server, or rely on OTLP metrics.

bun scripts/search-battery.mjs \
  --server "${QUASAR_SERVER_URL:-http://127.0.0.1:7180}" \
  --modes lexical,semantic,fusion \
  --repeats 20 \
  --concurrency 1 \
  --load-repeats 5 \
  --out "docs/proofs/search-battery-warm-post-spans-$(date -u +%Y-%m-%d).json"

# Inspect p95 from the battery summary (and/or /status metric histograms):
jq '.load // .summary // .' "docs/proofs/search-battery-warm-post-spans-$(date -u +%Y-%m-%d).json"
curl -fsS "${QUASAR_SERVER_URL}/status" | jq '.data.metrics // .data // .'
```

Accept only when the written JSON is from a real run against a warm server and
records p95 for all three modes under the 100ms warm-total bar (and scan p95
still under 60ms via `bun scripts/matrix-kernel-bench.ts` if re-checking the
kernel gate).

**This file does not claim those numbers.** Until that JSON is committed, live
warm p95 remains deferred; unit tests remain the CI-held span contract.

## Related

- OTLP sink enable: `docs/operations/observability-sink.md`
- Alert rules / healthy envelope: `packages/server/src/metrics.ts`
- Kernel scan gate: `scripts/matrix-kernel-bench.ts` → `docs/proofs/matrix-kernel-bench-2026-07-04.json`
- Query embed gate: `scripts/query-embed-bench.ts` → `docs/proofs/query-embed-bench-2026-07-04.json`
