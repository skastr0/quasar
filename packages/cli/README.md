# Quasar CLI

The Quasar CLI imports local AI agent session histories, validates ingestion
plans, and sends sanitized batches to a Quasar control server.

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
macOS and Linux on arm64/x64. The Convex control app and dashboard are not
published to npm.

## Configuration

Server-backed commands read `QUASAR_CONTROL_URL` and `QUASAR_CONTROL_TOKEN`, or
`~/.config/quasar/config.json` with:

```json
{
  "url": "http://127.0.0.1:3218",
  "token": "..."
}
```

Local discovery and planning commands are read-only against native agent
history folders.
