import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { quasarConvexLocalRoot } from "./quasar-state.mjs";

const host = process.env.QUASAR_TAILSCALE_HOST ?? "quasar.tail6742f6.ts.net";
const service = process.env.QUASAR_TAILSCALE_SERVICE ?? "svc:quasar";
const webPort = process.env.QUASAR_WEB_PORT ?? "5177";
const fallbackWebPort = process.env.QUASAR_FALLBACK_WEB_PORT ?? "8177";
const fallbackConvexPort = process.env.QUASAR_FALLBACK_CONVEX_PORT ?? "8178";
const fallbackApiPort = process.env.QUASAR_FALLBACK_API_PORT ?? "8179";
const localConfig = readLocalConfig();
const convexPort = String(localConfig?.ports?.cloud ?? 3217);
const apiPort = String(localConfig?.ports?.site ?? 3218);

configureServicePath("/", webPort);
configureServicePath("/quasar-convex", convexPort);
configureServicePath("/quasar-api", apiPort);
run("tailscale", ["serve", "advertise", service]);

const status = readServeStatus();
configureTcpFallback(status, fallbackWebPort, webPort);
configureTcpFallback(status, fallbackConvexPort, convexPort);
configureTcpFallback(status, fallbackApiPort, apiPort);

console.log(`Configured Tailscale Serve for https://${host}/ and fallback ports ${fallbackWebPort}, ${fallbackConvexPort}, ${fallbackApiPort}.`);

function configureServicePath(path, port) {
  run("tailscale", [
    "serve",
    "--service",
    service,
    "--https",
    "443",
    "--set-path",
    path,
    "--bg",
    `http://127.0.0.1:${port}`,
  ]);
}

function configureTcpFallback(status, port, targetPort) {
  const target = `127.0.0.1:${targetPort}`;
  if (status?.TCP?.[port]?.TCPForward === target) return;
  run("tailscale", ["serve", `--http=${port}`, "off"], { allowFailure: true });
  run("tailscale", ["serve", "--tcp", port, "--bg", target]);
}

function readLocalConfig() {
  const configPath = resolve(quasarConvexLocalRoot(), "config.json");
  if (!existsSync(configPath)) return undefined;
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function readServeStatus() {
  const result = spawnSync("tailscale", ["serve", "status", "--json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return JSON.parse(result.stdout);
}

function run(command, args, options = {}) {
  console.log(`\n> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0 && options.allowFailure !== true) {
    process.exit(result.status ?? 1);
  }
}
