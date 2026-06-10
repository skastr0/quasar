import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function quasarStateRoot() {
  return resolve(process.env.QUASAR_CONTROL_HOME ?? join(homedir(), ".quasar-control"));
}

export function quasarCliConfigRoot() {
  return resolve(process.env.QUASAR_HOME ?? join(homedir(), ".config", "quasar"));
}

export function quasarClientConfigPath() {
  return join(quasarCliConfigRoot(), "config.json");
}

export function quasarConvexLocalRoot() {
  return resolve(
    process.env.QUASAR_CONVEX_LOCAL_ROOT ??
      join(quasarStateRoot(), "local", "default"),
  );
}

export function quasarTailscaleHost() {
  const host = process.env.QUASAR_TAILSCALE_HOST?.trim();
  if (host !== undefined && host.length > 0) return host;

  console.error(
    "Missing QUASAR_TAILSCALE_HOST. Set it to your Tailscale Serve hostname, for example quasar.<tailnet>.ts.net.",
  );
  process.exit(1);
}

export function quasarConvexPublicUrl() {
  return (
    process.env.QUASAR_CONVEX_PUBLIC_URL?.trim() ??
    `https://${quasarTailscaleHost()}/quasar-convex`
  );
}

export function quasarConvexSitePublicUrl() {
  return (
    process.env.QUASAR_CONVEX_SITE_PUBLIC_URL?.trim() ??
    `https://${quasarTailscaleHost()}/quasar-api`
  );
}
