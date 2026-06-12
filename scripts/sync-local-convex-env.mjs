import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { quasarConvexLocalRoot } from "./quasar-state.mjs";

const configPath = resolve(quasarConvexLocalRoot(), "config.json");
if (!existsSync(configPath)) {
  console.error(`Missing ${configPath}. Run bun scripts/init-local-convex.mjs first.`);
  process.exit(1);
}

const googleApiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
if (googleApiKey === undefined || googleApiKey.trim().length === 0) {
  console.error("Missing GOOGLE_API_KEY or GEMINI_API_KEY in the shell environment.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const localConvexUrl = `http://127.0.0.1:${config.ports.cloud}`;
const response = await fetch(new URL("/api/update_environment_variables", localConvexUrl), {
  method: "POST",
  headers: {
    authorization: `Convex ${config.adminKey}`,
    "content-type": "application/json",
    "convex-client": "quasar-local-env-sync",
  },
  body: JSON.stringify({
    changes: [{ name: "GOOGLE_API_KEY", value: googleApiKey.trim() }],
  }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`Failed to sync local Convex env: ${response.status} ${body.slice(0, 200)}`);
  process.exit(1);
}

console.log("Synced local Convex env variables for Quasar embeddings.");
