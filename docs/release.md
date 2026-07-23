# Release Checklist

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

## Release

1. Confirm the target version is unpublished for the CLI wrapper and all four
   platform packages.
2. Set the CLI package version, its four optional platform dependency versions,
   and the CLI runtime version to the same value.
3. Regenerate `bun.lock`; never hand-edit its package resolutions.
4. Run `bun install --frozen-lockfile --cpu='*' --os='*'`.
5. Run `bun run release:check`.
6. Commit the release prep and open a pull request to `main`.
7. Require green CI on the pull request and again on the merged `main` commit.
8. Create and push the annotated tag `v<package-version>` at that merged commit.
   The publish workflow rejects tags that do not exactly match package metadata.
9. Approve the protected `release` environment and require the publish workflow
   to finish successfully.
10. Verify all five exact registry versions, provenance, and clean installs:

```bash
npx --package @skastr0/quasar-cli quasar --version
bunx -p @skastr0/quasar-cli quasar --version
pnpm --package @skastr0/quasar-cli dlx quasar --version
```

Published npm versions are permanent enough to require a new version for fixes.
