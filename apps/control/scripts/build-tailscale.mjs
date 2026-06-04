import { spawnSync } from "node:child_process";

const host = process.env.QUASAR_TAILSCALE_HOST ?? "quasar.tail6742f6.ts.net";
const convexUrl =
  process.env.QUASAR_CONVEX_PUBLIC_URL ?? `https://${host}/quasar-convex`;
const convexSiteUrl =
  process.env.QUASAR_CONVEX_SITE_PUBLIC_URL ?? `https://${host}/quasar-api`;

const result = spawnSync("bunx", ["next", "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_CONVEX_URL: convexUrl,
    NEXT_PUBLIC_CONVEX_SITE_URL: convexSiteUrl,
  },
});

process.exit(result.status ?? 0);
