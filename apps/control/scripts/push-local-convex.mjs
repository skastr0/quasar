import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { quasarConvexLocalRoot } from "./quasar-state.mjs";

const configPath = resolve(quasarConvexLocalRoot(), "config.json");
const envPath = resolve(".env.local");

if (!existsSync(configPath)) {
  console.error(`Missing ${configPath}. Run bun run local:init.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const previousEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
const result = spawnSync(
  "bunx",
  [
    "convex",
    "dev",
    "--url",
    `http://127.0.0.1:${config.ports.cloud}`,
    "--admin-key",
    config.adminKey,
    "--once",
  ],
  { stdio: "inherit" },
);

if (previousEnv !== null) writeFileSync(envPath, previousEnv, "utf8");
process.exit(result.status ?? 1);
