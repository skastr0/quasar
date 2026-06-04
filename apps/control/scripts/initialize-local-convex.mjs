import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { quasarConvexLocalRoot } from "./quasar-state.mjs";

const durableRoot = quasarConvexLocalRoot();
const durableConfig = resolve(durableRoot, "config.json");
const generatedRoot = resolve(".convex", "local", "default");
const generatedConfig = resolve(generatedRoot, "config.json");

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
  console.error(`
Convex did not create a local deployment.

Convex 1.40 requires a logged-in, configured project before creating local
deployment metadata. Run these once, then re-run local:init:

  bunx convex login
  bunx convex dev --configure new --dev-deployment local --once
  bun run local:init

This initializes Quasar's local Convex state only; it does not modify any agent
history files.
`);
  process.exit(result.status ?? 1);
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
