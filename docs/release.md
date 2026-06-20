# Release Checklist

Publishing is paused until the v2 product gates are green (see
`docs/architecture/quasar-effect-local-server-plan-2026-06-18.md`). Public artifacts
must describe a working system, not aspirations.

Quasar uses CI-first npm publishing for the CLI package. Do not publish locally
unless the maintainer explicitly approves a specific package/version exception.

## Public Repository Gate

- Confirm the repository license and copyright holder.
- Confirm no private agent histories, Tailscale hostnames, Tailnet IPs, local
  runtime data, `.env*` files, `.groundwork/`, or generated release artifacts are
  tracked.
- Run `bun run verify`.
- Run the readiness and package audits.

## npm Trusted Publishing Setup

Configure npm Trusted Publisher records for these packages:

- `@skastr0/quasar-cli`
- `@skastr0/quasar-cli-darwin-arm64`
- `@skastr0/quasar-cli-darwin-x64`
- `@skastr0/quasar-cli-linux-arm64`
- `@skastr0/quasar-cli-linux-x64`

Each trusted publisher must match:

- GitHub repository: `skastr0/quasar`
- Workflow filename: `npm-publish.yml`
- Environment: `release`
- Allowed action: `npm publish`

Use `npm trust list <package>` before tagging when the packages exist.

## First Publish

1. Verify the target package names and npm scope ownership.
2. Configure the GitHub `release` environment with maintainer approval.
3. Configure npm trusted publishers for every CLI/platform package.
4. Run `bun run verify`.
5. Run `bun run --cwd packages/cli build:npm-packages`.
6. Inspect `npm pack --dry-run` for `.release/npm/*` and `packages/cli`.
7. Commit the release prep.
8. Push the repository and release tag only after explicit maintainer approval.
9. Approve the protected `release` environment for the publish workflow.
10. Verify clean installs:

```bash
npx --package @skastr0/quasar-cli quasar --version
bunx -p @skastr0/quasar-cli quasar --version
pnpm --package @skastr0/quasar-cli dlx quasar --version
```

Published npm versions are permanent enough to require a new version for fixes.
