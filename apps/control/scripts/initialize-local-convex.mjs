import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { quasarConvexLocalRoot } from "./quasar-state.mjs";

const durableRoot = quasarConvexLocalRoot();
const durableConfig = resolve(durableRoot, "config.json");
const generatedRoot = resolve(".convex", "local", "default");
const generatedConfig = resolve(generatedRoot, "config.json");
const cloudPort = process.env.QUASAR_CONVEX_CLOUD_PORT ?? "3217";
const sitePort = process.env.QUASAR_CONVEX_SITE_PORT ?? "3218";

if (existsSync(durableConfig)) {
  console.log(`Quasar local Convex state is already initialized at ${durableRoot}`);
  process.exit(0);
}

console.log("Creating a local Convex deployment for Quasar...");
const result = spawnSync(
  "bunx",
  ["convex", "deployment", "create", "local", "--select"],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  console.warn(`
Convex did not create linked local deployment metadata. Falling back to an
anonymous local deployment scoped to Quasar on ports ${cloudPort}/${sitePort}.
`);
  createAnonymousLocalMetadata();
}

if (!existsSync(generatedConfig)) {
  console.error(
    `Convex finished, but ${generatedConfig} was not found. Check the Convex CLI output above.`,
  );
  process.exit(1);
}

mkdirSync(dirname(durableRoot), { recursive: true, mode: 0o700 });
cpSync(generatedRoot, durableRoot, {
  recursive: true,
  force: false,
  errorOnExist: true,
});

console.log(`Copied Quasar local Convex state to ${durableRoot}`);

function createAnonymousLocalMetadata() {
  if (existsSync(generatedRoot) && !existsSync(generatedConfig)) {
    rmSync(generatedRoot, { recursive: true, force: true });
  }

  const args = [
    "convex",
    "dev",
    "--once",
    "--skip-push",
    "--local-cloud-port",
    cloudPort,
    "--local-site-port",
    sitePort,
  ];
  if (process.env.QUASAR_CONVEX_BACKEND_VERSION !== undefined) {
    args.push("--local-backend-version", process.env.QUASAR_CONVEX_BACKEND_VERSION);
  }

  const anonymousResult = spawnSync("bunx", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      CONVEX_AGENT_MODE: "anonymous",
    },
  });

  if (anonymousResult.status !== 0) {
    console.error(`
Convex could not create anonymous local deployment metadata.

Run these once, then re-run local:init:

  bunx convex login
  bunx convex dev --configure new --dev-deployment local --once
  bun run local:init

This initializes Quasar's local Convex state only; it does not modify agent
history files.
`);
    process.exit(anonymousResult.status ?? 1);
  }
}
