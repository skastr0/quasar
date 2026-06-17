# Quasar CLI

The Quasar CLI discovers and parses local AI agent session histories,
read-only.

Status: pre-release. The CLI exposes discovery, ingest, project/session reads,
and tool-call reads against the self-hosted Convex OLTP backend. Search is not
currently a public command; the removed Convex Searchlight/RAG path is replaced
by LanceDB in the next search glyphs.

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

Local discovery commands are read-only against native agent history folders.
