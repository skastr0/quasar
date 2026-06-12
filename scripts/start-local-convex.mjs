import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { quasarConvexLocalRoot, quasarStateRoot } from "./quasar-state.mjs";

const localRoot = quasarConvexLocalRoot();
const configPath = resolve(localRoot, "config.json");

if (!existsSync(configPath)) {
  console.error(`Missing ${configPath}. Run bun scripts/init-local-convex.mjs first.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const deploymentName = config.deploymentName ?? "quasar-convex";
const binaryPath = join(
  homedir(),
  ".cache",
  "convex",
  "binaries",
  config.backendVersion,
  "convex-local-backend",
);
const storageDir = resolve(localRoot, "convex_local_storage");
const sqlitePath = resolve(localRoot, "convex_local_backend.sqlite3");
const runtimeTmpRoot = process.env.QUASAR_CONVEX_TMP_ROOT ?? join(quasarStateRoot(), "tmp");
mkdirSync(runtimeTmpRoot, { recursive: true, mode: 0o700 });
const runtimeTmpDir = mkdtempSync(join(runtimeTmpRoot, "convex-"));
const host = process.env.QUASAR_TAILSCALE_HOST ?? "quasar.tail6742f6.ts.net";
const convexOrigin =
  process.env.QUASAR_CONVEX_PUBLIC_URL ?? `https://${host}/quasar-convex`;
const convexSite =
  process.env.QUASAR_CONVEX_SITE_PUBLIC_URL ?? `https://${host}/quasar-api`;

if (!existsSync(binaryPath)) {
  console.error(`Missing ${binaryPath}. Run bunx convex dev --local --once first.`);
  process.exit(1);
}

const args = [
  "--interface",
  "127.0.0.1",
  "--port",
  String(config.ports.cloud),
  "--site-proxy-port",
  String(config.ports.site),
  "--convex-origin",
  convexOrigin,
  "--convex-site",
  convexSite,
  "--instance-name",
  deploymentName,
  "--instance-secret",
  config.instanceSecret,
  "--local-storage",
  storageDir,
  "--redact-logs-to-client",
  "--disable-beacon",
  sqlitePath,
];

const child = spawn(binaryPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    TMPDIR: runtimeTmpDir,
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  cleanupRuntimeTmpDir();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

process.on("exit", cleanupRuntimeTmpDir);

function cleanupRuntimeTmpDir() {
  makeWritableForCleanup(runtimeTmpDir);
  rmSync(runtimeTmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function makeWritableForCleanup(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }

  if (!stat.isDirectory()) {
    try {
      chmodSync(path, 0o600);
    } catch {}
    return;
  }

  try {
    chmodSync(path, 0o700);
  } catch {}
  for (const entry of readdirSync(path)) {
    makeWritableForCleanup(join(path, entry));
  }
}
