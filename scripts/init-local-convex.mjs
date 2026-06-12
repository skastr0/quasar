import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { quasarConvexLocalRoot } from "./quasar-state.mjs";

const localRoot = quasarConvexLocalRoot();
const configPath = resolve(localRoot, "config.json");

if (existsSync(configPath) && process.env.QUASAR_FORCE_INIT_LOCAL_CONVEX !== "true") {
  console.log(`Local Convex config already exists: ${configPath}`);
  process.exit(0);
}

const env = readEnvFile(resolve(".env.local"));
const adminKey = env.CONVEX_SELF_HOSTED_ADMIN_KEY;
if (adminKey === undefined || adminKey.trim().length === 0) {
  console.error("Missing CONVEX_SELF_HOSTED_ADMIN_KEY in .env.local");
  process.exit(1);
}

const [deploymentName, sourceSecret] = adminKey.split("|", 2);
if (deploymentName === undefined || sourceSecret === undefined || sourceSecret.length === 0) {
  console.error("CONVEX_SELF_HOSTED_ADMIN_KEY must have the form <deployment>|<secret>");
  process.exit(1);
}

const instanceSecret = isLocalBackendSecret(sourceSecret) ? sourceSecret : randomBytes(32).toString("hex");

const backendVersion = latestBackendVersion();
const binaryPath = join(homedir(), ".cache", "convex", "binaries", backendVersion, "convex-local-backend");
const localAdminKey = generateAdminKey({ binaryPath, deploymentName, instanceSecret });
mkdirSync(localRoot, { recursive: true, mode: 0o700 });

writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      deploymentName,
      backendVersion,
      adminKey: localAdminKey,
      instanceSecret,
      ports: {
        cloud: 3217,
        site: 3218,
      },
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o600 },
);
chmodSync(configPath, 0o600);
console.log(`Wrote ${configPath}`);

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function isLocalBackendSecret(value) {
  return /^[0-9a-f]{64}$/iu.test(value);
}

function generateAdminKey({ binaryPath, deploymentName, instanceSecret }) {
  const result = spawnSync(
    binaryPath,
    ["keygen", "admin-key", "--instance-name", deploymentName, "--instance-secret", instanceSecret],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stderr.trim() || result.stdout.trim() || "Failed to generate Convex admin key");
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function latestBackendVersion() {
  const binariesRoot = join(homedir(), ".cache", "convex", "binaries");
  const candidates = existsSync(binariesRoot)
    ? Array.from(new Bun.Glob("precompiled-*/convex-local-backend").scanSync({ cwd: binariesRoot }))
    : [];
  if (candidates.length === 0) {
    console.error("Missing Convex local backend binary. Run `bunx convex dev --local --once` first.");
    process.exit(1);
  }
  candidates.sort();
  return basename(candidates.at(-1).replace(/\/convex-local-backend$/u, ""));
}
