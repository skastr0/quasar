# Architecture Documents

Quasar 0.5.x has **one coherent, authoritative architecture**: SQLite as the whole OLTP data plane (truth, durable queue, trigger-maintained scoped FTS5, `message_vectors`, `session_enrichments`, and `ingest_runs`), a resident f16 vector matrix scanned via SIMD (simsimd FFI) for exact semantic and fusion search, a local fp32 ONNX query embedder, row-diffing transactional ingest, thirteen provider adapters, and multi-format trajectory and research projections.

---

## System Architecture Map

```
Provider Session Files (13 Adapters)
  │ (CLI discovery, parsing, normalization, redaction, fingerprinting)
  ▼
MappedSession Wire Envelope (quasar.normalized-session/v1)
  │ (POST /ingest/session over HTTP)
  ▼
Quasar Effect Server (Bun + Effect Runtime)
  ├── SQLite Data Plane (/data/quasar/quasar.sqlite)
  │    ├── projects, sessions, messages, tool_calls, events
  │    ├── execution_contexts, usage_records, session_edges, artifacts
  │    ├── FTS5 Scoped Lexical Index (trigger-maintained on messages)
  │    ├── message_vectors (f16 vector blobs, model, modality)
  │    ├── embedding_cache (f32 cached vectors)
  │    ├── session_enrichments (namespaced derived analysis)
  │    ├── ingest_runs (lifecycle tracking)
  │    └── durable_queue (embed-message jobs)
  │
  ├── Search Substrate
  │    ├── Lexical: FTS5 scoped-token search (BM25 ranking, instant at COMMIT)
  │    ├── Semantic: Resident f16 vector matrix (SharedArrayBuffer exact SIMD scan)
  │    ├── Fusion: Reciprocal Rank Fusion (RRF) combining FTS5 and SIMD hits
  │    └── Query Embedder: Local fp32 ONNX pipeline (with synthetic fallback)
  │
  └── Serving & Projection APIs
       ├── Resource Endpoints (/projects, /sessions, /messages, /tool-calls, /tool-call, etc.)
       ├── Trajectory Projections (/trajectory -> Quasar v1, Letta v1, Harbor ATIF v1.7)
       ├── Reproducible Research Export (/research-export -> streaming NDJSON frames)
       ├── Composable Session Enrichments (/session-enrichments GET / POST)
       └── Maintenance & Diagnostics (/health, /ready, /status, /maintenance/*)
```

---

## Active Architecture Documents

| Document | Scope & Authority |
| --- | --- |
| **[Quasar — First-Principles Re-Architecture Map](quasar-first-principles-rearchitecture-2026-07-03.md)** | **Authoritative search substrate & data plane.** Defines SQLite as the entire data plane (OLTP truth, queue, FTS5 lexical index, `message_vectors`), the resident f16 vector matrix with exact SIMD scan (`simsimd` kernel), the local fp32 ONNX query embedder, and zero-background-machinery lifecycle. LanceDB was completely removed on 2026-07-04. |
| **[Quasar Session Contract and Projection Plan](quasar-session-contract-and-projections-2026-07-26.md)** | **Authoritative normalized session contract & projections.** Establishes `quasar.normalized-session/v1` as the versioned source-fact contract, event-faithful message/tool attribution, per-turn execution contexts/models, `quasar.trajectory/v1` agent trajectories, Letta Trajectory v1 compatibility, and Harbor ATIF v1.7 benchmark export. |
| **[CLI ⇄ Server HTTP Wire Contract](cli-server-http-contract.md)** | **Authoritative wire protocol.** Exhaustively specifies all HTTP endpoints (`/ingest/*`, `/projects`, `/sessions`, `/session-detail`, `/trajectory`, `/research-export`, `/messages`, `/tool-calls`, `/tool-call`, `/session-enrichments`, `/search/*`, `/ingest-runs`, `/maintenance/*`), headers, query parameters, error responses, and pagination. |
| **[Quasar — Data-Reality Plan](quasar-data-reality-plan-2026-06-11.md)** | **Measured corpus evidence & normalized entity model.** Provider reality, turn-mapping rules, mandatory sensitive-text redaction (`redactSensitive`), and the fundamental store-at-read-grain principle. |
| **[Provider Native Identity Rules](provider-native-identity.md)** | **Content-derived session identity.** Rules for extracting stable, path-independent session IDs from provider payloads across all 13 supported providers. |
| **[Adapter Boundary Hardening and Triage](adapter-boundary-hardening-triage.md)** | **Adapter resilience & diagnostic triage.** Boundary rejection of corrupt or unrecoverable provider records without crashing ingest or persister loops. |
| **[Quasar Scale Engineering](quasar-scale-engineering.md)** | **Scale benchmark evidence.** Measurement evidence, indexing benchmarks, and scale verification. |
| **[Observability Sink and Watchdog](observability-sink-and-watchdog.md)** | **Telemetry & diagnostics.** Opt-in OTLP sink (`grafana/otel-lgtm`), metrics gauges, trace spans, and server watchdog. |
| **[Server Docker & Tailscale Runbook](../operations/server-docker-tailscale.md)** | **Operational deployment.** Mac mini Docker compose setup, persistent volumes, secrets, `svc:quasar` Tailscale Service resolution, maintenance flows, backup/restore, and daemon installation. |

---

## Superseded Documents (Historical Provenance)

- **[Quasar — Effect Local Server Plan](quasar-effect-server-plan-2026-06-18.md)** — The 2026-06 migration architecture (LanceDB derived index era). Its SQLite truth-store and queue design carried forward into the 0.5.x architecture; its LanceDB search half was completely replaced by SQLite FTS5 and the resident f16 vector matrix.

---

## Key 0.5.x Architectural Principles

1. **Measured Data is the Contract:** Never invent artificial byte budgets or amplification ratios for legitimate session text. Admitted turns are stored at the grain they are read. Malformed provider noise is rejected at the adapter boundary with named diagnostics.
2. **SQLite is the Whole Data Plane:** Truth, FTS5 lexical index, `message_vectors`, `session_enrichments`, and the durable queue all reside in `/data/quasar/quasar.sqlite`. Backup is an atomic SQLite `VACUUM INTO` snapshot (`tar` with `machine.json`).
3. **Exact Scan Beats Vector Indexes:** At corpus scale (<1M turns, ~1 GB at f16), an exact SIMD scan over a resident f16 matrix loaded at boot yields recall 1.0, sub-100ms latency, instant filtered masking, and zero index maintenance or compaction overhead.
4. **Local Query Embedding:** Queries are embedded in-process using an fp32 ONNX pipeline (`nomic-embed-text-v1.5`), eliminating external network calls during search.
5. **Thirteen Provider Adapters:** First-class adapters for `codex`, `claude`, `opencode`, `grok`, `kimi`, `hermes`, `antigravity`, `omp`, `pi`, `prime`, `cursor`, `devin`, and `amp`.
6. **Interchange Projections:** Stored normalized facts are projected on-demand into token-efficient Quasar agent trajectories, Letta Trajectory v1, or Harbor ATIF v1.7 benchmark formats without mutating underlying storage.
7. **Composable Enrichments & Research Export:** Independent namespaces for derived AI analysis (`quasar.session-enrichment/v1`) and streaming NDJSON endpoints (`quasar.research-export/v1`) for reproducible corpus research.
