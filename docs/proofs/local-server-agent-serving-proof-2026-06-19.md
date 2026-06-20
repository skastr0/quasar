# Quasar local-server agent serving proof — 2026-06-19

## Verdict

PASS: the Effect local-server exposes the agent-facing read/search/tool-call surface
over the Mac mini Tailscale IP. The serving path is SQLite truth plus LanceDB search;
this proof does not add storage fields, indexes, embedding policy, or ingest behavior.

## Runtime under proof

- URL: `http://<mac-mini-tailscale-ip>:6180`
- Runtime: Docker local-server on the Mac mini
- Truth store: SQLite at `/data/quasar/quasar.sqlite`
- Search: embedded LanceDB under `/data/quasar/search.lance`
- Client mode: `QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180`

## Agent tool contract

| Tool | Backing route | Required inputs | Optional filters |
| --- | --- | --- | --- |
| projects list | `GET /projects` | none | `limit`, `offset` |
| sessions list | `GET /sessions` | none | `projectKey`, `provider`, `limit`, `offset` |
| session read | `GET /messages` | `sessionId` | `limit` |
| search | `GET /search/lexical`, `/search/semantic`, `/search/fusion` | `q` or `query` | `projectKey`, `role`, `limit` |
| tool-calls list | `GET /tool-calls` | none | `sessionId`, `projectKey`, `provider`, `toolName`, `limit`, `offset` |
| tool-call read | `GET /tool-call` | `id` | none |

## HTTP proof

Health over Tailscale IP:

```bash
curl -fsS 'http://<mac-mini-tailscale-ip>:6180/health' | python3 -m json.tool
```

Observed counts after deploy:

```json
{
  "projects": 100,
  "sessions": 3729,
  "messages": 135992,
  "toolCalls": 136371
}
```

Fusion search over real Quasar sessions with `projectKey` and `role` filter:

```bash
curl -fsS 'http://<mac-mini-tailscale-ip>:6180/search/fusion?q=incremental%20sync%20local-server&projectKey=git%3Agithub.com%2Fskastr0%2Fquasar&role=user&limit=1' \
  | python3 -m json.tool
```

Returned a real hit:

```json
{
  "sessionId": "grok:machine:de134fd406c9b3eb261fbf560c52390d:78bf19164fbac20f81a219c40d4132e5",
  "seq": 4,
  "role": "user",
  "projectKey": "git:github.com/skastr0/quasar"
}
```

Tool-call list over real Quasar sessions:

```bash
curl -fsS 'http://<mac-mini-tailscale-ip>:6180/tool-calls?projectKey=git%3Agithub.com%2Fskastr0%2Fquasar&provider=grok&toolName=list_dir&limit=1' \
  | python3 -m json.tool
```

Returned real tool-call rows including:

```json
{
  "id": "grok:tool:machine:de134fd406c9b3eb261fbf560c52390d:d259a2b6ef9ebaf565f6e71878dff67f",
  "sessionId": "grok:machine:de134fd406c9b3eb261fbf560c52390d:00a3bb68442ff4691bb37d9683713257",
  "seq": 0,
  "toolName": "list_dir",
  "projectKey": "git:github.com/skastr0/quasar",
  "provider": "grok"
}
```

Tool-call read over the same route:

```bash
curl -fsS 'http://<mac-mini-tailscale-ip>:6180/tool-call?id=grok%3Atool%3Amachine%3Ade134fd406c9b3eb261fbf560c52390d%3Ad259a2b6ef9ebaf565f6e71878dff67f' \
  | python3 -m json.tool
```

Returned the same `list_dir` row by stable tool-call id.

## CLI-wrapper proof

Project list via `QUASAR_LOCAL_SERVER_URL`:

```bash
QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180 \
  bun packages/cli/src/cli.ts projects --limit 1
```

Fusion search via `QUASAR_LOCAL_SERVER_URL`:

```bash
QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180 \
  bun packages/cli/src/cli.ts search \
    --mode fusion \
    --query "incremental sync local-server" \
    --project-key git:github.com/skastr0/quasar \
    --role user \
    --limit 1
```

Tool-call list via `QUASAR_LOCAL_SERVER_URL`:

```bash
QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180 \
  bun packages/cli/src/cli.ts tool-calls \
    --project-key git:github.com/skastr0/quasar \
    --provider grok \
    --tool-name list_dir \
    --limit 1
```

Tool-call read via `QUASAR_LOCAL_SERVER_URL`:

```bash
QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180 \
  bun packages/cli/src/cli.ts tool-call \
    --id grok:tool:machine:de134fd406c9b3eb261fbf560c52390d:d259a2b6ef9ebaf565f6e71878dff67f
```

## Automated validation

```bash
bun test packages/local-server/test/search.test.ts packages/local-server/test/server.test.ts
bun run --cwd packages/local-server test
bun run --cwd packages/local-server typecheck
```

Results:

- targeted serving/search tests: pass
- local-server full suite: 64 pass / 0 fail
- local-server typecheck: pass

## Scope notes

- The current checked-in `.prism` directory only contains workflow state, not a
  generated Quasar MCP wrapper. MCP adapters should wrap the HTTP/CLI contract above.
- This proof intentionally does not test the parked runtime or assert its absence.
- Operator-only commands (`operator-ingest`, `operator-maintain`,
  `operator-worker-tick`, `operator-embed-batch`, `operator-recover-leases`) are not
  part of the default agent tool surface.
