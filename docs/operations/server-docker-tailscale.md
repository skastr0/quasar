# Quasar server runbook

This is the operational path for Quasar on the Mac mini.

- Docker supervises the Effect local server.
- SQLite in `/data/quasar/quasar.sqlite` is the whole data plane: OLTP truth,
  trigger-maintained FTS (lexical search), and `message_vectors` (embeddings).
- Semantic/fusion search serves live from a resident f16 vector matrix loaded
  at boot (exact scan, simsimd kernel). Query embedding runs on a local fp32
  ONNX model baked into the image (~30s background load; bounded synthetic
  fallback covers the window). If the process boots with no vectors for the
  active profile, those routes return an honest 503 `SemanticDisabled`.
- Client access is through the Tailscale Service hostname assigned to `svc:quasar`.
- `platform/server/.env` is local-only and must not be committed.
- Optional local OTLP sink (`grafana/otel-lgtm`) is an **opt-in compose profile**
  — off by default. Enable with `COMPOSE_PROFILES=otel` only; see
  `docs/operations/observability-sink.md` and
  `docs/architecture/observability-sink-and-watchdog.md`.

## One-time setup

```bash
cp platform/server/.env.example platform/server/.env
chmod 600 platform/server/.env
```

Set at least:

- `QUASAR_PUBLISH_HOST=0.0.0.0` unless Docker can bind the Tailscale IP directly.
- `QUASAR_PUBLISH_PORT=7180` (host publish port; the container always binds 6180 internally). 7180 is dedicated to quasar — 6180 on the Mac mini belongs to an unrelated dev server. The canonical client URL is `http://<mac-mini-tailnet-ip>:7180`.
- `QUASAR_INGEST_TOKEN=<long random token>`. Remote write ingest is disabled unless this is configured, and client machines must send the same token.
- `SYNTHETIC_API_KEY`. The embedding provider is pinned to `synthetic` in
  `compose.yaml`; a provider flip is an explicit receipted cutover, never a
  deploy side-effect.

Keep `QUASAR_HOME=/data/quasar` pinned in compose. That preserves Quasar's machine identity and idempotency across container rebuilds.

## Daily commands

Use package scripts from the repo root:

```bash
bun run server:deploy      # build/recreate service after code/env changes
bun run server:ps          # compose service state
bun run server:logs        # follow logs
bun run server:ready       # lightweight readiness check
bun run server:status      # SQLite/queue/cache status
bun run server:materialize # embedding vector materialization with JSON receipt
bun run server:backup      # write ./quasar-truth-backup.tar
```

Raw helper form:

```bash
bun scripts/server-ops.mjs materialize --out docs/proofs/materialization-closure.json
bun scripts/server-ops.mjs exec -- sh -lc 'du -sh /data/quasar/*'
```

## Deploy / update flow

1. Pull or checkout the desired code.
2. Run validation when code changed:

   ```bash
   bun run typecheck
   bun run --cwd packages/server test
   ```

3. Rebuild/recreate Docker:

   ```bash
   bun run server:deploy
   ```

4. Verify:

   ```bash
   bun run server:ps
   bun run server:ready
   bun run server:status
   ```

5. From another Tailnet client, verify the `svc:quasar` Tailscale Service:

   ```bash
   curl -fsS https://<quasar-service-tailnet-hostname>/ready
   curl -fsS https://<quasar-service-tailnet-hostname>/status
   ```

If hostname resolution fails, debug Tailscale Services/DNS. Do not switch client
configuration back to the Mac mini device IP as the long-term path.

## Tailscale Service proof

There are two separate proof boundaries:

- Mac mini service-host proof: the server and Tailscale Service proxy are wired.
- Remote client proof: a different tailnet device resolves and reaches the service
  hostname without `--resolve` or hosts-file edits.

Tailscale Services are reached by MagicDNS name or TailVIP by clients with the
necessary access permissions; keep Quasar client configuration aligned with that
model. Reference:
<https://tailscale.com/docs/features/tailscale-services>.

On the Mac mini, verify the service host:

```bash
tailscale serve get-config --all
tailscale serve status --json
tailscale status --json | jq -r '.Self.CapMap."service-host"[0]."svc:quasar"[]'
curl -fsS http://127.0.0.1:7180/ready
```

If the service hostname does not resolve on the Mac mini itself, inspect the
netmap before changing client config. Service access is policy-shaped, and the
service host may not be listed as a source client for its own TailVIP:

```bash
tailscale debug resolve <quasar-service-tailnet-hostname>
tailscale debug netmap | jq '.PacketFilterRules // .PacketFilter'
```

To prove the Mac mini proxy path without relying on local service-host DNS, use
the TailVIP advertised for `svc:quasar`:

```bash
tailvip="$(tailscale status --json | jq -r '.Self.CapMap."service-host"[0]."svc:quasar"[0]')"
curl -fsS --resolve <quasar-service-tailnet-hostname>:443:"$tailvip" \
  https://<quasar-service-tailnet-hostname>/ready
```

That proves only the service host and SNI proxy. It does not replace remote
client proof. From a remote tailnet client with service access:

```bash
curl -fsS https://<quasar-service-tailnet-hostname>/ready

tmp="$(mktemp -d)"
printf '%s\n' '{"schemaVersion":3,"projectKey":"quasar","serverUrl":"https://<quasar-service-tailnet-hostname>"}' > "$tmp/config.json"
QUASAR_CONFIG="$tmp/config.json" npx -y @skastr0/quasar-cli stats
QUASAR_CONFIG="$tmp/config.json" npx -y @skastr0/quasar-cli search \
  --query "effect server" \
  --mode lexical \
  --limit 3
```

## Agent / MCP serving contract

Agent clients should treat the Docker server HTTP API as the canonical data
plane and set the client wrapper environment to the `svc:quasar` Tailscale
Service hostname:

```bash
export QUASAR_SERVER_URL=https://<quasar-service-tailnet-hostname>
```

Equivalent client config:

```json
{
  "schemaVersion": 3,
  "projectKey": "quasar",
  "serverUrl": "https://<quasar-service-tailnet-hostname>",
  "ingestToken": "<same-token-as-mac-mini-platform-server-env>"
}
```

Omit `ingestToken` for read/search-only agent wrappers. Include it only for
operator write ingest and daemon installs.

The `quasar` CLI mirrors the HTTP API and is safe to wrap as MCP tools. The
serving surface is read/search only:

| Agent job | CLI wrapper | HTTP route | Filters |
| --- | --- | --- | --- |
| Project list | `projects` | `GET /projects` | `limit`, `offset` |
| Session list | `sessions` | `GET /sessions` | `projectKey`, `provider`, `limit`, `offset` |
| Session read | `messages --session-id <id>` | `GET /messages` | `sessionId`, `limit` |
| Search | `search --query <text> --mode lexical\|semantic\|fusion` | `GET /search/<mode>` | `q`/`query`, `projectKey`, `role=user\|assistant`, `limit`; all three modes serve live (`semantic`/`fusion` from the resident vector matrix) |
| Tool-call list | `tool-calls` | `GET /tool-calls` | `sessionId`, `projectKey`, `provider`, `toolName`, `limit`, `offset` |
| Tool-call read | `tool-call --id <id>` | `GET /tool-call` | `id` |
| Remote ingest | `ingest --provider all` | `POST /ingest/session` | operator only; set `QUASAR_SERVER_URL` and `QUASAR_INGEST_TOKEN` |

Notes for wrappers:

- Use `projectKey` at the HTTP layer and `--project-key` at the CLI layer.
- `role` applies to searchable message rows (`user`, `assistant`, `reasoning`);
  tool-call input/output remains structural/lexical evidence.
- Operator-only commands: agent wrappers should not expose ingest, embedding,
  maintenance, or backfill as default tools. Those remain operator actions.
- If a wrapper cannot reach `QUASAR_SERVER_URL`, fail closed with a connection
  error instead of falling back to stale data.

## Keeping the server fresh

The server does not ingest provider histories. New sessions reach it only through
CLI clients that read local history folders and POST mapped sessions over HTTP — see
[Ingesting from another Tailscale machine](#ingesting-from-another-tailscale-machine).

Lexical search needs no maintenance: the FTS index is trigger-maintained on the
SQLite messages truth table, so ingested rows are searchable immediately.
Embedding is not a cron shell loop: the server-owned embedding worker leases
queued `embed-message` jobs, batches provider calls, uses the cache, and backs
off on retryable provider limits.

## Embedding Materialization Proof

Before running a full materialization/backfill against the canonical service, take
a truth backup:

```bash
bun run server:backup
```

Then run the materialization loop from the host against the published server port:

```bash
bun run server:materialize
```

By default this writes `docs/proofs/materialization-closure-<timestamp>.json` and
also prints the same JSON envelope to stdout. The wrapper requires the active
embedding provider to match the pinned deploy provider (`synthetic`) by default;
pass `--require-provider local` only as part of an explicit provider cutover.
Pass `--out` to choose a stable proof path:

```bash
bun scripts/server-ops.mjs materialize --out docs/proofs/materialization-closure.json
```

The receipt is accepted only when the CLI loop reaches both gates:

- `coverage.vectorlessMessages = 0`
- `embedding.provider` matches the required provider

## SQLite-First Spike Proof

The SQLite-first proof command snapshots a source SQLite database with
`VACUUM INTO`, then creates proof-only FTS/vector tables inside the work database.
It never writes to the source database. Saved embeddings are read from
`embedding_cache` by `(cacheNamespace, documentHash)` and replayed into
`proof_message_vectors`; a missing row means the cache is incomplete, not that the
source text must be changed.

For the local-vs-cached embedding parity gate, pass the cache namespace that owns
the saved corpus vectors and an explicit cosine threshold:

```bash
bun run proof:sqlite-first --source-db /path/to/quasar.sqlite \
  --cache-namespace synthetic:hf:nomic-ai/nomic-embed-text-v1.5:768:search_document \
  --fts-samples 60 \
  --filter-role assistant \
  --vector-limit all \
  --scan-limit all \
  --scan-samples 60 \
  --scan-kernel usearch \
  --scan-threads 1 \
  --parity-sample 1000 \
  --parity-threshold <cosine-threshold> \
  --out docs/proofs/sqlite-first-proof.json
```

The FTS section is accepted only when `filteredBenchmarks` records the applied
project/role filters and p95/p99 timings over the requested sample count. The
parity section is accepted only when `sampleSize` equals the requested sample,
`passed` is true, and the report records the exact threshold used. The QSR-229
exact-scan gate still requires target-container native-kernel evidence; the proof
command records `usearch` exact-kernel timing separately from the pure-JS
baseline. Accept the native scan only when the target-container report records
`exactScan.kernel.package == "usearch"` and the import/exact-search smoke for the
same image succeeds.

## Ingesting from another Tailscale machine

Install the released CLI on the other machine, point it at the `svc:quasar`
Tailscale Service hostname, then run ingest. The CLI reads local history folders
on that machine and POSTs mapped sessions to the Mac mini server. The server is
still the authority for idempotency, SQLite writes (row-level diff applies),
embedding-cache lookup, and embed-queue draining.

```bash
npm install -g @skastr0/quasar-cli
export QUASAR_SERVER_URL=https://<quasar-service-tailnet-hostname>
export QUASAR_INGEST_TOKEN=<same-token-as-mac-mini-platform-server-env>

# Optional when provider roots are non-standard on that machine.
export QUASAR_CODEX_ROOT="$HOME/.codex"
export QUASAR_CLAUDE_ROOT="$HOME/.claude"
export QUASAR_OPENCODE_ROOT="$HOME/.local/share/opencode"
export QUASAR_GROK_ROOT="$HOME/.grok"
export QUASAR_HERMES_ROOT="$HOME/.hermes"

# First smoke test.
quasar stats
quasar search --mode lexical --query "quasar local server" --limit 3

# Ingest this machine's corpus into the Mac mini server.
quasar ingest --provider all --summary

# Watch server-owned workers drain embeddings/indexing.
quasar workers
quasar stats
```

You may pass `--server https://<quasar-service-tailnet-hostname>` and
`--ingest-token <token>`, or set `serverUrl` and `ingestToken` in
`~/.config/quasar/config.json`, instead of exporting `QUASAR_SERVER_URL`
and `QUASAR_INGEST_TOKEN`. The read/search API remains reachable without this
token; remote write ingest fails closed before provider scanning when it is
missing.

Recommended schedule:

- before risky changes: `bun run server:backup`

On remote Macs, use the released CLI's production daemon installer. It installs a
user LaunchAgent with `StartInterval=60` by default. The LaunchAgent calls
`quasar daemon run`, which holds a local lock and then runs the remote ingest
path (`quasar ingest --provider all --summary --server ...`) so a slow first
ingest cannot overlap the next minute tick.

```bash
npm install -g @skastr0/quasar-cli
export QUASAR_SERVER_URL=https://<quasar-service-tailnet-hostname>
export QUASAR_INGEST_TOKEN=<same-token-as-mac-mini-platform-server-env>

quasar daemon install --interval-seconds 60
quasar daemon status
```

Override through flags when you do not want to export environment variables:

```bash
quasar daemon install \
  --server https://<quasar-service-tailnet-hostname> \
  --ingest-token <token> \
  --interval-seconds 60
```

Uninstall:

```bash
quasar daemon uninstall
```

The same released-CLI daemon is how the Mac mini host ingests its own corpus: it
runs as a client that reads local histories and POSTs them to the server over HTTP.

## Worker policy

Use one active embedding profile per running server process. For the Mac mini default
(the provider itself is pinned to `synthetic` in `compose.yaml`):

```env
QUASAR_EMBEDDING_MODEL=hf:nomic-ai/nomic-embed-text-v1.5
QUASAR_EMBEDDING_DIMENSIONS=768
QUASAR_EMBEDDING_TASK=search_document
QUASAR_EMBEDDING_DOCUMENT_PREFIX="search_document: "
QUASAR_EMBEDDING_QUERY_PREFIX="search_query: "
```

The embedding worker drains `embed-message` jobs into SQLite `message_vectors`. The embedding cache and `message_vectors` table are profile-scoped. Quasar does not intentionally embed one message into multiple embedding spaces during ordinary operation. Side-by-side profile comparison is an explicit proof workflow, not daemon behavior.

## Backup / restore

Backup:

```bash
bun run server:backup
```

This writes `./quasar-truth-backup.tar` with:

- `quasar.sqlite`, produced by SQLite `VACUUM INTO` so the snapshot is coherent while the server is running,
- `machine.json`, so provider session IDs remain stable after restore.

SQLite is the whole data plane, so this backup is complete: the FTS index is
rebuilt by the store's `user_version` migration and `message_vectors` rides
inside the same file.

Restore is intentionally manual because it replaces the truth store:

```bash
bun run server:down
docker volume rm quasar-server_quasar-data
bun run server:up
bun scripts/server-ops.mjs exec -- sh -lc 'rm -rf /data/quasar'
docker compose --env-file platform/server/.env -f platform/server/compose.yaml cp ./quasar-truth-backup.tar server:/tmp/quasar-truth-backup.tar
bun scripts/server-ops.mjs exec -- sh -lc 'mkdir -p /data/quasar && tar -xf /tmp/quasar-truth-backup.tar -C /data/quasar'
bun run server:restart
```

## Troubleshooting checklist

1. `bun run server:ps` — container running and healthy?
2. `bun run server:logs` — crash loop, provider errors, SQLite errors?
3. `bun run server:status` — queue pending/leased/failed counts?
4. `bun scripts/server-ops.mjs exec -- sh -lc 'du -sh /data/quasar/*'` — disk growth sane?
5. If jobs are leased forever after a crash, restart the server (`bun run server:restart`); stale worker leases are recovered automatically by the embedding worker.
6. If search misses fresh sessions, re-run ingest from the source machine's CLI
   (`quasar ingest --provider all`); lexical search serves them immediately from
   the trigger-maintained FTS index.

## Production proof artifacts

- `docs/proofs/server-production-proof-2026-06-19.md`
- `docs/proofs/embedding-retrieval-comparison-2026-06-19.md`
- `docs/proofs/embedding-retrieval-comparison-2026-06-19.json`
