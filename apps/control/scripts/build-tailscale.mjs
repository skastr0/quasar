import { spawnSync } from "node:child_process";
import {
  quasarConvexPublicUrl,
  quasarConvexSitePublicUrl,
} from "./quasar-state.mjs";

const convexUrl = quasarConvexPublicUrl();
const convexSiteUrl = quasarConvexSitePublicUrl();

const result = spawnSync("bunx", ["next", "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_CONVEX_URL: convexUrl,
    NEXT_PUBLIC_CONVEX_SITE_URL: convexSiteUrl,
  },
});

process.exit(result.status ?? 0);
