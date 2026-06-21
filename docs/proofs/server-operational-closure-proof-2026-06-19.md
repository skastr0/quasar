# Local-server operational closure proof — 2026-06-19

This proof records the current production posture for the Quasar Effect server on the Mac mini. The canonical runtime is Docker + SQLite truth + embedded LanceDB derived search + Synthetic/Nomic embeddings. Access proof uses the direct Mac mini Tailscale IP, redacted below as `<mac-mini-tailscale-ip>`.

## Verdict

PASS — the server path is connected end to end:

- Docker service is running and healthy.
- LaunchAgent incremental sync is installed and loaded with a 60 second interval.
- Manual incremental sync tick scans all configured providers and skips unchanged sessions without enqueuing duplicate work.
- SQLite truth contains the expected corpus scale.
- Synthetic/Nomic is the active embedding profile.
- Worker queue is empty; embedding and index-repair workers are enabled and idle.
- LanceDB has the lexical message table and active-profile vector table with FTS/vector indexes; maintenance was run and the indexed row counts are current.
- Fusion search over the direct Tailscale IP returns real hits.
- Tool-call retrieval over the direct Tailscale IP returns structural tool-call rows.
- Root typecheck and tests pass.

## Runtime health

Command:

```bash
bun run server:ps
```

Result:

```text
quasar-server-server-1   quasar-server:latest   Up ... (healthy)   0.0.0.0:6180->6180/tcp
```

Command:

```bash
curl -fsS 'http://<mac-mini-tailscale-ip>:6180/health'
```

Result summary:

```json
{
  "ok": true,
  "command": "health",
  "data": {
    "status": "ok",
    "home": "/data/quasar",
    "sqlite": "/data/quasar/quasar.sqlite",
    "stats": {
      "projects": 100,
      "sessions": 3734,
      "messages": 136014,
      "toolCalls": 136454
    }
  }
}
```

Operator note: `127.0.0.1:6180` on this Mac currently responds with a separate Next.js development server. The Docker service is healthy internally and reachable on the Tailscale IP. Do not use localhost as the production proof boundary on this machine; use the direct Tailscale IP as the runbook states.

## Incremental sync

Command:

```bash
bun run server:sync-status
```

Result summary:

```json
{
  "ok": true,
  "command": "status",
  "label": "com.quasar.server-sync",
  "installed": true,
  "loaded": true,
  "output_contains": ["run interval = 60 seconds", "last exit code = 0"]
}
```

Manual tick command:

```bash
bun run server:sync-tick
```

Result summary:

```text
codex:       seen 638,  written 0, skipped 638, failed 0, jobs 0, duration 89 ms
claude:      seen 1371, written 0, skipped 1371, failed 0, jobs 0, duration 118 ms
opencode:    seen 881,  written 0, skipped 881, failed 0, jobs 0, duration 1753 ms
grok:        seen 347,  written 0, skipped 347, failed 0, jobs 0, duration 189 ms
hermes:      seen 476,  written 0, skipped 476, failed 0, jobs 0, duration 1605 ms
kimi:        seen 0,    written 0, skipped 0, failed 0, jobs 0, duration 7 ms
antigravity: seen 20,   written 0, skipped 20, failed 0, jobs 0, duration 21 ms
```

The tick is intentionally uncapped by default. Freshness comes from frequent host ticks plus adapter `shouldParseSession` probes, not CLI-side throughput caps. The server owns embedding/index backpressure.

## Queue, workers, and embedding profile

Command:

```bash
bun run server:status
```

Result summary:

```json
{
  "queue": { "pending": 0, "leased": 0, "failed": 0, "byKind": [] },
  "embeddings": {
    "cached": 62795,
    "pending": 0,
    "profile": {
      "provider": "synthetic",
      "model": "hf:nomic-ai/nomic-embed-text-v1.5",
      "dimensions": 768,
      "task": "search_document",
      "cacheNamespace": "synthetic:hf:nomic-ai/nomic-embed-text-v1.5:768:search_document"
    }
  },
  "workers": {
    "enabled": true,
    "workers": ["embeddings", "index-repair"],
    "lastErrors": {}
  }
}
```

Policy posture:

- `user` and `assistant` messages are semantic-search eligible.
- Tool-call input/output stays structural and lexical evidence; it is not semantically embedded.
- Stale embed jobs for superseded message hashes are skipped/acked, not failed.
- Ordinary operation uses one active embedding profile. Side-by-side model comparison is an explicit proof workflow, not daemon behavior.

## LanceDB derived search state

Command:

```bash
bun run server:maintain
bun run server:lance
bun run server:status -- --lance
```

Result summary:

```json
{
  "tables": [
    {
      "name": "messages",
      "rows": 125378,
      "indices": [{ "name": "text_idx", "type": "FTS", "columns": ["text"] }]
    },
    {
      "name": "messages_<active-profile>",
      "rows": 125378,
      "indices": [
        { "name": "vector_idx", "type": "IvfFlat", "columns": ["vector"] },
        { "name": "text_idx", "type": "FTS", "columns": ["text"] }
      ]
    }
  ],
  "status_lance": {
    "messages_text_idx": {
      "numIndexedRows": 125378,
      "numUnindexedRows": 0
    },
    "active_profile_maintenance": {
      "text_idx": { "numIndexedRows": 125378, "numUnindexedRows": 0 },
      "vector_idx": { "numIndexedRows": 125378, "numUnindexedRows": 0 }
    }
  }
}
```

SQLite `messages` is larger than the LanceDB row count because LanceDB indexes the message search surface (`user` and `assistant` rows). Tool calls and other structural rows remain outside semantic indexing by policy.

Maintenance remains explicit. Run `bun run server:maintain` after large ingests or when status/LanceDB inspection shows unindexed rows, missing indexes, or derived-store drift.

## Agent-serving proof

Fusion search command:

```bash
curl -fsS 'http://<mac-mini-tailscale-ip>:6180/search/fusion?q=incremental%20ingest&role=assistant&limit=3'
```

Result summary: `ok: true`, command `search/fusion`, three assistant message hits returned. The top hit text was:

```text
Ingest is progressing healthily (99% CPU). Standing by for the completion notification.
```

Tool-call retrieval command:

```bash
curl -fsS 'http://<mac-mini-tailscale-ip>:6180/tool-calls?limit=3'
```

Result summary: `ok: true`, command `tool-calls`, three structural tool-call rows returned with provider, session id, sequence, tool name, status, input, and output fields.

## Validation

Command:

```bash
bun run typecheck
```

Result: pass.

Command:

```bash
bun run test
```

Result: pass.

Summary:

```text
packages/core:         12 files, 64 tests passed
packages/search:        1 file, 12 tests passed
packages/server:  9 files, 65 tests passed
packages/cli:           9 files, 42 tests passed
```

## Operational stance

The system is ready to operate in the current architecture:

1. Keep Docker server running on the Mac mini.
2. Keep the 60-second LaunchAgent sync tick installed.
3. Use direct Tailscale IP for agent wrappers and proofs.
4. Let the server drain embedding/index jobs; do not run long-lived shell embedding jobs.
5. Use Synthetic/Nomic as the default bulk text embedding profile.
6. Run explicit maintenance after large ingest bursts.
7. Back up SQLite truth and machine identity; rebuild LanceDB as derived state when needed.
