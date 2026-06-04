import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  quasarClientConfigPath,
  quasarConvexLocalRoot,
} from "./quasar-state.mjs";

const host = process.env.QUASAR_TAILSCALE_HOST ?? "quasar.tail6742f6.ts.net";
const service = process.env.QUASAR_TAILSCALE_SERVICE ?? "svc:quasar";
const dashboardUrl = process.env.QUASAR_DASHBOARD_URL ?? `https://${host}/`;
const apiUrl =
  process.env.QUASAR_CONVEX_SITE_PUBLIC_URL ?? `https://${host}/quasar-api`;
const localDashboardUrl =
  process.env.QUASAR_LOCAL_DASHBOARD_URL ??
  `http://127.0.0.1:${process.env.QUASAR_WEB_PORT ?? "5177"}/`;

ensureLocalConvexMetadata();
const localConfig = readLocalConfig();
if (localConfig === undefined) {
  console.error(
    `Missing Quasar local Convex metadata at ${localConfigPath()}. Run bun run local:init.`,
  );
  process.exit(1);
}

const localConvexUrl =
  process.env.QUASAR_LOCAL_CONVEX_URL ??
  `http://127.0.0.1:${localConfig.ports?.cloud ?? 3217}`;

for (const [command, args] of [
  ["bun", ["run", "test"]],
  ["bunx", ["tsc", "--noEmit"]],
  ["bun", ["scripts/backup-local-convex.mjs"]],
]) {
  run(command, args);
}

await ensureLocalConvexBackend(localConvexUrl);

run("bun", ["scripts/push-local-convex.mjs"]);
run("bun", ["scripts/build-tailscale.mjs"]);
run("bun", ["scripts/install-launchd.mjs"]);
await verify(
  "local Convex backend",
  `${localConvexUrl}/api/v1/get_canonical_urls`,
  { acceptedStatuses: [200, 403] },
);
await verify("local dashboard", localDashboardUrl, { method: "HEAD" });
run("bun", ["scripts/configure-tailscale-serve.mjs"]);

const clientConfig = readJsonIfExists(quasarClientConfigPath());
await verifyClientConfig(clientConfig);

if (process.env.QUASAR_VERIFY_SERVICE_HOST === "true") {
  const serviceIp = tailscaleServiceIp(service);
  if (serviceIp !== undefined) {
    console.log(`Using ${serviceIp} for ${host} service-host verification.`);
  }

  await verify("dashboard", dashboardUrl, { method: "HEAD" }, serviceIp);

  const token = process.env.QUASAR_CONTROL_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    console.log(
      "Skipping authenticated API smoke check: QUASAR_CONTROL_TOKEN is not set.",
    );
  } else {
    await verify(
      "Quasar API",
      `${apiUrl}/api/health`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
      serviceIp,
    );
  }
} else {
  console.log(
    "Skipping service-host smoke; MagicDNS service URLs are verified from external tailnet clients. Set QUASAR_VERIFY_SERVICE_HOST=true to force it.",
  );
}

console.log(`Deployed Quasar Control to ${dashboardUrl}`);

function ensureLocalConvexMetadata() {
  if (readLocalConfig() !== undefined) return;
  run("bun", ["scripts/initialize-local-convex.mjs"]);
}

async function ensureLocalConvexBackend(localConvexUrl) {
  const healthUrl = `${localConvexUrl}/api/v1/get_canonical_urls`;
  const healthInit = {
    acceptedStatuses: [200, 403],
    attempts: 5,
  };
  if (await canVerify(healthUrl, healthInit)) {
    console.log(`Verified existing local Convex backend: ${healthUrl}`);
    return;
  }

  run("bun", ["scripts/install-launchd.mjs"]);
  await verify("local Convex backend", healthUrl, {
    acceptedStatuses: [200, 403],
  });
}

async function verify(label, url, init = {}, resolveIp) {
  const attempts = Number.parseInt(
    String(init.attempts ?? process.env.QUASAR_DEPLOY_VERIFY_ATTEMPTS ?? "240"),
    10,
  );
  const delayMs = Number.parseInt(
    process.env.QUASAR_DEPLOY_VERIFY_DELAY_MS ?? "1000",
    10,
  );
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const status =
        resolveIp === undefined
          ? await fetchStatus(url, init)
          : curlStatus(url, init, resolveIp);
      if (isAcceptedStatus(status, init.acceptedStatuses)) {
        console.log(`Verified ${label}: ${url} (${status})`);
        return;
      }
      lastError = new Error(String(status));
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`Failed to verify ${label}: ${url} (${message})`);
  process.exit(1);
}

async function canVerify(url, init = {}) {
  const attempts = Number.parseInt(String(init.attempts ?? "1"), 10);
  const delayMs = Number.parseInt(String(init.delayMs ?? "1000"), 10);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const status = await fetchStatus(url, init);
      if (isAcceptedStatus(status, init.acceptedStatuses)) return true;
    } catch {
      // The main verifier reports failures with context.
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

async function fetchStatus(url, init) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
  });
  return response.status;
}

function curlStatus(url, init, resolveIp) {
  const parsed = new URL(url);
  const port =
    parsed.port.length > 0
      ? parsed.port
      : parsed.protocol === "https:"
        ? "443"
        : "80";
  const args = [
    "-sS",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "--max-time",
    "10",
    "--resolve",
    `${parsed.hostname}:${port}:${resolveIp}`,
  ];
  if (init.method === "HEAD") args.push("-I");
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    args.push("-H", `${key}: ${value}`);
  }
  args.push(url);

  const result = spawnSync("curl", args, { encoding: "utf8" });
  if (result.status !== 0) {
    const message =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `curl exited ${result.status}`;
    throw new Error(message);
  }
  return Number.parseInt(result.stdout.trim(), 10);
}

function verifyClientConfig(config) {
  if (config === undefined) {
    console.error(`Missing Quasar client config at ${quasarClientConfigPath()}.`);
    process.exit(1);
  }

  const requiredUrls = ["dashboardUrl", "convexUrl", "apiUrl"];
  for (const key of requiredUrls) {
    if (typeof config[key] !== "string" || config[key].length === 0) {
      console.error(`Quasar client config is missing ${key}.`);
      process.exit(1);
    }
  }

  return Promise.all([
    verify("tailnet dashboard", config.dashboardUrl, { method: "HEAD" }),
    verify(
      "tailnet Convex backend",
      `${config.convexUrl}/api/v1/get_canonical_urls`,
      { acceptedStatuses: [200, 403] },
    ),
    verify("tailnet API path", `${config.apiUrl}/api/health`, {
      acceptedStatuses: [200, 401],
    }),
  ]);
}

function tailscaleServiceIp(serviceName) {
  const result = run("tailscale", ["status", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status !== 0) return undefined;

  const status = JSON.parse(result.stdout);
  const hosts = status.Self?.CapMap?.["service-host"] ?? [];
  for (const hostEntry of hosts) {
    const addresses = hostEntry?.[serviceName];
    const ipv4 = addresses?.find(
      (address) => typeof address === "string" && !address.includes(":"),
    );
    if (ipv4 !== undefined) return ipv4;
  }
  return undefined;
}

function readLocalConfig() {
  return readJsonIfExists(localConfigPath());
}

function localConfigPath() {
  return resolve(quasarConvexLocalRoot(), "config.json");
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function isAcceptedStatus(status, acceptedStatuses) {
  return (
    (Array.isArray(acceptedStatuses) && acceptedStatuses.includes(status)) ||
    (status >= 200 && status < 300)
  );
}

function run(command, args, options = {}) {
  console.log(`\n> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: options.capture === true ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0 && options.allowFailure !== true) {
    process.exit(result.status ?? 1);
  }
  return result;
}
