# Quasar Convex Platform Probe

Date: 2026-06-11
Scope: self-hosted Convex platform parity for Quasar v2

This report records the QSR-043 platform probe. It intentionally excludes the
sync contract, ingest schema, and product search/read surfaces.

## Baseline

- Convex backend image: `ghcr.io/get-convex/convex-backend@sha256:edd7959f3464ed661f6663f646db205d5d61bda606c969b074dfb3c69ed71463`
- Convex dashboard image: `ghcr.io/get-convex/convex-dashboard@sha256:bbc4d2c43d19fd6f2791dd6c5153a76e127f3eea489c1639e5acf66999c216bf`
- Convex CLI version: `1.41.0`
- Docker version: `29.4.0`
- Docker Compose version: `v5.1.2`
- Host architecture: `linux/aarch64` Docker engine on macOS arm64

## Probe Results

| Probe | Result | Measurement / Evidence |
| --- | --- | --- |
| Docker Compose backend/dashboard up | pass | `docker compose --env-file platform/convex/.env -f platform/convex/compose.yaml up -d`; backend healthy on `:4210`, dashboard on `:7791` |
| Admin key generated locally | pass | key generated inside backend container and stored only in ignored `.env.local`; `GET /api/check_admin_key` returned `200` with `{"success":true,"allowedOps":[],"isReadOnly":false}` |
| `npx convex ai-files install` | pass | `bun x convex ai-files install` refreshed `convex/_generated/ai/guidelines.md` and installed Convex agent skills |
| `npx convex dev --once` validation loop | pass | bare schema push succeeded against `http://127.0.0.1:4210` in `479.83ms`; temporary probe schema push succeeded in `1.77s` |
| Text search index self-hosted, staged backfill | pass | 24 `probeTexts` rows inserted before the search index existed; staged `probeTexts.by_body` push succeeded; removing `staged: true` enabled the index; search for `metadata convex` returned 10 rows |
| Vector index 1536 dims from an action | pass | `probeVectors.by_embedding` accepted 1536 dimensions; action `ctx.vectorSearch` for seed 3 returned marker `vector-3` with score `1` |
| RAG component deploys/functions self-hosted | partial | component `rag` and `rag/workpool` installed on self-hosted; the round-trip action executed before the later storage write-rate rejection, but its result was not emitted because the runner aborted later |
| Scheduler and crons fire | pass | 2-second cron inserted ticks; read-only snapshot after probe showed `79` cron rows |
| Mutation latency 200 / 400 / 800 records | pending | runner aborted before emitting latency JSON because the later storage probe hit `TooManyWrites` |
| 512 KiB ConvexHttpClient transport latency | pending | runner aborted before emitting transport JSON because the later storage probe hit `TooManyWrites` |
| ~10 MB realistic text at-rest multiplier | blocked | storage probe inserted 140 docs / `9,175,040` useful text bytes before Convex rejected the next write with `TooManyWrites`; backend reported deployment limit `4 MiB bytes written per 1 second` |
| Second tailnet device reachability | pending | pending |
| `npx convex insights --details` self-hosted | unavailable | CLI returned `Insights are only available for cloud deployments. Local deployments do not have insights data.` Performance gates must use code/runtime probes per the Convex performance-audit skill. |
| Export -> upgrade -> verify drill | pending | pending |
| Probe schema deleted | pass | repository schema restored to `defineSchema({})`; temporary probe modules and RAG config removed; `bun x convex codegen` regenerated an empty public/internal API and empty `components` binding |

## Blockers

- The initially scaffolded commit tag `a339553ffad1f3cf4691663a506d975b6cbfcab9`
  booted but reproduced upstream issue get-convex/convex-backend#173:
  generated admin keys returned `401 BadAdminKey` from `/api/check_admin_key`
  and `bun x convex dev --once`. A disposable probe using the official current
  image accepted generated keys; the working image manifest digests are now
  pinned in `platform/convex`.
- The official local backend ports `:3210`/`:3211` are occupied on this host by
  the local Tower Control Convex backend. Quasar's checked-in local defaults now
  use `:4210`/`:4211`/`:7791` to keep platform checks reproducible.
- The at-rest multiplier probe hit a Convex write-rate rejection before reaching
  the requested ~10MB sample: `TooManyWrites`, `Your deployment is limited to 4
  MiB bytes written per 1 second. Reduce your write rate or upgrade to a larger
  deployment.` Per AGENTS.md, this halts QSR-043 until there is a written shape
  decision. Continuing by adding sleeps or rate limiting would hide the
  measured platform boundary. The official limits page lists the S16 mutation
  write-throughput limit as `4 MiB`, confirming the observed boundary.

## Decision Packet

The stop-line decisions are gathered in
`docs/architecture/quasar-v2-stop-line-decisions-2026-06-11.md`.
