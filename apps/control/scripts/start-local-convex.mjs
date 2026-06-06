import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { quasarConvexLocalRoot } from "./quasar-state.mjs";

const localRoot = quasarConvexLocalRoot();
const configPath = resolve(localRoot, "config.json");

if (!existsSync(configPath)) {
  console.error(
    `Missing ${configPath}. Run bun run local:init or restore a Quasar local Convex backup.`,
  );
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const deploymentName = config.deploymentName ?? "anonymous-quasar-control";
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
const runtimeTmpRoot =
  process.env.QUASAR_CONVEX_TMP_ROOT ?? join(homedir(), ".quasar-control", "tmp");
mkdirSync(runtimeTmpRoot, { recursive: true, mode: 0o700 });
const runtimeTmpDir = mkdtempSync(join(runtimeTmpRoot, "convex-"));
const host = process.env.QUASAR_TAILSCALE_HOST?.trim();
const convexOrigin =
  process.env.QUASAR_CONVEX_PUBLIC_URL?.trim() ??
  (host !== undefined && host.length > 0
    ? `https://${host}/quasar-convex`
    : `http://127.0.0.1:${config.ports.cloud}`);
const convexSite =
  process.env.QUASAR_CONVEX_SITE_PUBLIC_URL?.trim() ??
  (host !== undefined && host.length > 0
    ? `https://${host}/quasar-api`
    : `http://127.0.0.1:${config.ports.site}`);

if (!existsSync(binaryPath)) {
  console.error(`Missing ${binaryPath}. Run bunx convex dev --local --once first.`);
  process.exit(1);
}

const child = spawn(
  binaryPath,
  [
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
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      TMPDIR: runtimeTmpDir,
      GOOGLE_API_KEY:
        process.env.GOOGLE_API_KEY ??
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
        process.env.GEMINI_API_KEY,
      GEMINI_API_KEY:
        process.env.GEMINI_API_KEY ??
        process.env.GOOGLE_API_KEY ??
        process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    },
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
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
  rmSync(runtimeTmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
