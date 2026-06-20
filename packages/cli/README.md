# Quasar CLI

The Quasar CLI discovers, parses, ingests, and queries local AI-agent session
histories.

The production control surface is the Effect local server with SQLite truth,
durable worker queues, and LanceDB search. The npm package ships that production
CLI as a prebuilt Bun standalone binary behind a small Node launcher.

## Install

```bash
npm install -g @skastr0/quasar-cli
quasar --help
```

Ephemeral runner examples:

```bash
npx --package @skastr0/quasar-cli quasar --help
bunx -p @skastr0/quasar-cli quasar --help
pnpm --package @skastr0/quasar-cli dlx quasar --help
```

The npm package ships a Node launcher plus prebuilt Bun standalone binaries for
macOS and Linux on arm64/x64.

## Connect to a Mac mini Quasar server

Use the Mac mini's direct Tailscale IP, not MagicDNS, as the proof boundary:

```bash
export QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180

quasar stats
quasar search --mode fusion --query "quasar local server" --limit 3
quasar ingest --provider all --summary
quasar workers
```

`ingest` reads native local history folders on the machine running the CLI and
POSTs mapped sessions to the configured server. The server owns idempotent SQLite
writes, embedding cache lookup, and search-index queue draining.

Override provider roots when needed:

```bash
export QUASAR_CODEX_ROOT="$HOME/.codex"
export QUASAR_CLAUDE_ROOT="$HOME/.claude"
export QUASAR_OPENCODE_ROOT="$HOME/.local/share/opencode"
export QUASAR_GROK_ROOT="$HOME/.grok"
export QUASAR_HERMES_ROOT="$HOME/.hermes"
```
