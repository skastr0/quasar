import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { quasarConvexLocalRoot } from "./quasar-state.mjs";

const host = process.env.QUASAR_TAILSCALE_HOST ?? "quasar.tail6742f6.ts.net";
const dashboardUrl = process.env.QUASAR_DASHBOARD_URL ?? `https://${host}/`;
const apiUrl = process.env.QUASAR_CONVEX_SITE_PUBLIC_URL ?? `https://${host}/quasar-api`;
const localConfig = readJsonIfExists(resolve(quasarConvexLocalRoot(), "config.json"));
const localConvexUrl =
  process.env.QUASAR_LOCAL_CONVEX_URL ??
  `http://127.0.0.1:${localConfig?.ports?.cloud ?? 3217}`;
const localDashboardUrl =
  process.env.QUASAR_LOCAL_DASHBOARD_URL ??
  `http://127.0.0.1:${process.env.QUASAR_WEB_PORT ?? "5177"}/`;

for (const [command, args] of [
  ["bun", ["scripts/initialize-local-convex.mjs"]],
  ["bun", ["run", "test"]],
  ["bunx", ["tsc", "--noEmit"]],
  ["bun", ["scripts/backup-local-convex.mjs"]],
]) {
  run(command, args);
}

run("bun", ["scripts/push-local-convex.mjs"]);
run("bun", ["scripts/build-tailscale.mjs"]);
run("bun", ["scripts/install-launchd.mjs"]);
await verify("local Convex backend", `${localConvexUrl}/api/v1/get_canonical_urls`, {
  acceptedStatuses: [200, 403],
});
await verify("local dashboard", localDashboardUrl, { method: "HEAD" });
run("bun", ["scripts/configure-tailscale-serve.mjs"]);

const token = process.env.QUASAR_CONTROL_TOKEN?.trim();
if (token) {
  await verify("Quasar API", `${apiUrl}/api/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
} else {
  console.log("Skipping authenticated API smoke check: QUASAR_CONTROL_TOKEN is not set.");
}

console.log(`Deployed Quasar Control to ${dashboardUrl}`);

function run(command, args) {
  console.log(`\n> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function verify(label, url, init = {}) {
  const attempts = Number.parseInt(String(init.attempts ?? "120"), 10);
  const delayMs = Number.parseInt(process.env.QUASAR_DEPLOY_VERIFY_DELAY_MS ?? "1000", 10);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, cache: "no-store" });
      if (
        (Array.isArray(init.acceptedStatuses) && init.acceptedStatuses.includes(response.status)) ||
        (response.status >= 200 && response.status < 300)
      ) {
        console.log(`Verified ${label}: ${url} (${response.status})`);
        return;
      }
      lastError = new Error(String(response.status));
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  console.error(`Failed to verify ${label}: ${url} (${lastError instanceof Error ? lastError.message : String(lastError)})`);
  process.exit(1);
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}
