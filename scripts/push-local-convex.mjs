import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { quasarConvexLocalRoot, quasarStateRoot } from "./quasar-state.mjs";

const configPath = resolve(quasarConvexLocalRoot(), "config.json");
if (!existsSync(configPath)) {
  console.error(`Missing ${configPath}. Run bun scripts/init-local-convex.mjs first.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const tmpRoot = process.env.QUASAR_CONVEX_TMP_ROOT ?? join(quasarStateRoot(), "tmp");
mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
const tmpDir = mkdtempSync(join(tmpRoot, "convex-push-"));
const selectionEnvPath = join(tmpDir, "deployment.env");
let status = 1;

try {
  writeFileSync(
    selectionEnvPath,
    envFile({
      CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${config.ports.cloud}`,
      CONVEX_SELF_HOSTED_ADMIN_KEY: config.adminKey,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(selectionEnvPath, 0o600);

  const result = spawnSync("bunx", ["convex", "dev", "--env-file", selectionEnvPath, "--once"], {
    stdio: "inherit",
  });
  status = result.status ?? 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

process.exit(status);

function envFile(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${envValue(value)}`)
    .join("\n")}\n`;
}

function envValue(value) {
  if (/^[A-Za-z0-9._~+/=-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}
