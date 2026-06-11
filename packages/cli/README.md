# Quasar CLI

The Quasar CLI discovers and parses local AI agent session histories,
read-only.

Status: pre-release. Only local commands exist today (doctor, capabilities,
schema, examples, sources discover). Ingest, search, and session reads arrive
with the v2 server (see `docs/architecture/quasar-v2-greenfield-plan-2026-06-10.md`
in the repository).

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
