# Contributing

Quasar is a solo-maintained experimental project. Issues are the preferred
contribution path for now.

## Scope

Useful issues include reproducible bugs, adapter format changes, redaction
misses, CLI ergonomics, and small proposals with clear maintenance cost.

Large feature work, public API changes, storage model changes, and new provider
adapters should start as an issue before a pull request.

## Local Setup

```bash
bun install
bun run typecheck
bun run test
bun run build
```

Do not include native agent histories, local Convex state, Tailscale hostnames,
tokens, or private session data in issues, pull requests, fixtures, or logs.

Contributions are accepted under the repository license.
