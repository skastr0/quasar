# Quasar CLI

The Quasar CLI discovers, parses, ingests, and queries local AI-agent session
histories.

The production control surface is the Effect local server with SQLite truth,
durable worker queues, and LanceDB search. The npm package ships that production
CLI as a prebuilt Bun standalone binary behind a small Node launcher.

## Install

```bash
npm install -g @skastr0/quasar-cli
quasar --version
quasar --help
```

Ephemeral runner examples:

```bash
npx --package @skastr0/quasar-cli quasar --version
bunx -p @skastr0/quasar-cli quasar --version
pnpm --package @skastr0/quasar-cli dlx quasar --version
```

The npm package ships a Node launcher plus prebuilt Bun standalone binaries for
macOS and Linux on arm64/x64.

## Connect to a Mac mini Quasar server

Use the Tailscale Service hostname assigned to `svc:quasar`:

```bash
export QUASAR_SERVER_URL=https://<quasar-service-tailnet-hostname>
export QUASAR_INGEST_TOKEN=<same-token-configured-on-the-mac-mini-server>

quasar stats
quasar search --mode fusion --query "quasar local server" --limit 3
quasar ingest --provider all --summary
quasar workers
```

Or configure the default server once:

```json
{
  "schemaVersion": 3,
  "projectKey": "quasar",
  "serverUrl": "https://<quasar-service-tailnet-hostname>",
  "ingestToken": "<same-token-configured-on-the-mac-mini-server>"
}
```

`ingest` reads native local history folders on the machine running the CLI and
POSTs mapped sessions to the configured server. The server owns idempotent SQLite
writes, embedding cache lookup, and search-index queue draining.
Remote ingest requires `ingestToken`, `QUASAR_INGEST_TOKEN`, or
`--ingest-token <token>`; read and search commands do not.

Override provider roots when needed:

```bash
export QUASAR_CODEX_ROOT="$HOME/.codex"
export QUASAR_CLAUDE_ROOT="$HOME/.claude"
export QUASAR_OPENCODE_ROOT="$HOME/.local/share/opencode"
export QUASAR_GROK_ROOT="$HOME/.grok"
export QUASAR_HERMES_ROOT="$HOME/.hermes"
```
