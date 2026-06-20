# Quasar local-server production proof — 2026-06-19

## Verdict

PASS: the Mac mini Docker local-server is serving SQLite truth, LanceDB lexical/fusion/semantic search, and the server-owned embedding worker drained the Synthetic/Nomic corpus queue without pending or failed jobs.

## Runtime target

- Server URL: `http://<mac-mini-tailscale-ip>:6180`
- Runtime: Docker Compose service `quasar-local-server-local-server-1`
- Tailscale access: direct Mac mini Tailscale IP, not MagicDNS
- Storage home inside container: `/data/quasar`
- SQLite truth: `/data/quasar/quasar.sqlite`
- LanceDB: embedded in the local-server container/process; no separate LanceDB container
- Embedding profile: `synthetic:hf:nomic-ai/nomic-embed-text-v1.5:768:search_document`

## SQLite truth

`GET /status` returned:

```json
{
  "projects": 100,
  "sessions": 3712,
  "messages": 135438,
  "toolCalls": 135176,
  "ingestRuns": 0
}
```

## Queue drain

SQLite queue inventory after the final worker pass:

```json
[
  { "kind": "embed-message", "status": "completed", "count": 124796 },
  { "kind": "index-session", "status": "completed", "count": 3712 }
]
```

`GET /status` confirmed no active work remained:

```json
{
  "queue": {
    "pending": 0,
    "leased": 0,
    "failed": 0,
    "byKind": []
  },
  "workers": {
    "enabled": true,
    "workers": ["embeddings"],
    "lastErrors": {}
  }
}
```

## Embedding cache / idempotency

Embedding cache inventory after the run:

```json
[
  { "model": "gemini-embedding-001", "count": 124689 },
  { "model": "synthetic:hf:nomic-ai/nomic-embed-text-v1.5:768:search_document", "count": 62256 }
]
```

The Synthetic cache count is lower than the message-row count because it is keyed by profile plus content hash; repeated message text reuses cached vectors instead of paying the provider again. The queue has one completed job per embedded search row.

The last two jobs were legitimate user-message rows of ~1.48M characters each. They failed as single provider calls with Synthetic HTTP 500. The worker now chunks large message text for provider calls, averages chunk vectors into one message vector, caches under the original message/profile identity, and still writes one search row per message. This preserves message-level search semantics and avoids turning tool-call payloads into embedded documents.

## LanceDB maintenance

Final maintenance was run in-container rather than over the HTTP request path:

```bash
docker compose --env-file platform/local-server/.env \
  -f platform/local-server/compose.yaml \
  exec -T local-server sh -lc \
  "cd /app && timeout 240s bun packages/cli/src/cli.ts operator-maintain --vector true --optimize true"
```

Active Synthetic/Nomic table stats from that maintenance pass:

```json
{
  "tableName": "messages_c3ludGhldGljOmhmOm5vbWlj",
  "rowCount": 124796,
  "indices": [
    {
      "name": "vector_idx",
      "indexType": "IvfFlat",
      "columns": ["vector"],
      "numIndexedRows": 124796,
      "numUnindexedRows": 0,
      "distanceType": "cosine"
    },
    {
      "name": "text_idx",
      "indexType": "FTS",
      "columns": ["text"],
      "numIndexedRows": 124796,
      "numUnindexedRows": 0
    }
  ]
}
```

The lexical `messages` table is also compacted and indexed for FTS:

```json
{
  "tableName": "messages",
  "rowCount": 124796,
  "versionCount": 1,
  "tableStats": {
    "numRows": 124796,
    "numIndices": 1,
    "fragmentStats": {
      "numFragments": 1,
      "numSmallFragments": 0
    }
  },
  "indices": [
    {
      "name": "text_idx",
      "indexType": "FTS",
      "columns": ["text"],
      "numIndexedRows": 124796,
      "numUnindexedRows": 0
    }
  ]
}
```

## Search proof

The retrieval comparison script was run against the live Tailscale endpoint:

```bash
bun scripts/compare-local-search.mjs \
  --server http://<mac-mini-tailscale-ip>:6180 \
  --name synthetic-nomic \
  --limit 5 \
  --out docs/proofs/embedding-retrieval-comparison-2026-06-19.md \
  --json docs/proofs/embedding-retrieval-comparison-2026-06-19.json
```

Artifact:

- `docs/proofs/embedding-retrieval-comparison-2026-06-19.md`
- `docs/proofs/embedding-retrieval-comparison-2026-06-19.json`

Representative live fusion query:

```bash
curl -fsS http://<mac-mini-tailscale-ip>:6180/search/fusion \
  --get \
  --data-urlencode 'q=embedding profile LanceDB messages table vector dimension mismatch' \
  --data-urlencode 'limit=3'
```

Result: HTTP 200 with real session hits from the local corpus, including prior Quasar embedding/indexing work.

## Validation

Code validation after worker hardening:

```bash
bun run --cwd packages/local-server test test/embeddings.test.ts
bun run typecheck
```

Results:

- `packages/local-server` embedding tests: 19 pass / 0 fail
- root typecheck: pass across core, search, local-server, and CLI

## Notes

- The HTTP maintenance endpoint was interrupted around 12 seconds by the request path while the service stayed healthy. Long maintenance should run via the local CLI inside the container or be moved to a server-owned background maintenance job.
- The active vector table may report a tiny late-write fragment after final writes; the indexes report 0 unindexed rows. Routine maintenance can compact the final small fragment.
