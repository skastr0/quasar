# Self-Hosted Convex Platform

Quasar v2 uses a self-hosted Convex backend for serving state. This directory
pins the platform container versions and keeps operational settings out of shell
history.

## Start

```bash
cp platform/convex/.env.example platform/convex/.env
docker compose --env-file platform/convex/.env -f platform/convex/compose.yaml up -d
```

After the backend is healthy, generate the local admin key:

```bash
docker compose --env-file platform/convex/.env -f platform/convex/compose.yaml exec backend ./generate_admin_key.sh
```

Store the key in the ignored root `.env.local`:

```bash
CONVEX_SELF_HOSTED_URL='http://127.0.0.1:3217'
CONVEX_SELF_HOSTED_ADMIN_KEY='<generated admin key>'
```

Then validate Convex functions with:

```bash
npx convex dev --once
```

## Pinned Images

The Compose file uses immutable Convex backend/dashboard manifest digests rather
than `latest`.

Verified manifests on 2026-06-11:

- backend manifest list:
  `ghcr.io/get-convex/convex-backend@sha256:edd7959f3464ed661f6663f646db205d5d61bda606c969b074dfb3c69ed71463`
  - linux/amd64: `sha256:080e5b1b5565efbbee0632b471ce9ff4f614ef0d26349c9529438ff65ed255d5`
  - linux/arm64: `sha256:4894ab50b78c82bd8b35db6f1ad88487c77f41ee2a24c1b4617a78bc4e2d5bea`
- dashboard manifest list:
  `ghcr.io/get-convex/convex-dashboard@sha256:bbc4d2c43d19fd6f2791dd6c5153a76e127f3eea489c1639e5acf66999c216bf`
  - linux/amd64: `sha256:1725d7914f66432c94f46c69500696391d65cf420fc7e4e977dd393e92b08b3e`
  - linux/arm64: `sha256:c8d5220d9b86da5bc77033f33da2875578ad583b9c1e7ee0eaaa57e23b9d2361`

The previously tested commit tag
`a339553ffad1f3cf4691663a506d975b6cbfcab9` booted but rejected its own
generated admin keys on this machine. The digest pair above accepted generated
admin keys in the QSR-043 probe.

## Reachability

Local defaults bind to ports that are not used by the local Tower Control
Convex backend on this machine:

- backend API: `http://127.0.0.1:3217`
- HTTP actions/site proxy: `http://127.0.0.1:3218`
- dashboard: `http://127.0.0.1:5177`

The example `.env` is already aligned to the existing Quasar Tailscale Serve
configuration: `/quasar-convex`, `/quasar-api`, and the DNS-free fallback ports
`8177`, `8178`, and `8179` exposed on the tailnet IP.
