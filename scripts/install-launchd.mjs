import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { quasarClientConfigPath, quasarConvexLocalRoot, quasarStateRoot } from "./quasar-state.mjs";

const repoRoot = process.cwd();
const nodePath = process.execPath;
const homeDir = homedir();
const nodeLtsBin = join(homeDir, ".local", "share", "mise", "installs", "node", "lts", "bin");
const bunBin =
  process.env.QUASAR_BUN_BIN ?? (process.versions.bun ? process.execPath : spawnOutput("which", ["bun"]));
const launchAgentsDir = join(homeDir, "Library", "LaunchAgents");
const logsDir = join(repoRoot, "logs");
const quasarTmpDir = join(quasarStateRoot(), "tmp");
const domain = `gui/${process.getuid?.() ?? spawnOutput("id", ["-u"])}`;
const tailscaleHost = process.env.QUASAR_TAILSCALE_HOST ?? "quasar.tail6742f6.ts.net";
const publicConvexUrl =
  process.env.QUASAR_CONVEX_PUBLIC_URL ?? `https://${tailscaleHost}/quasar-convex`;
const publicConvexSiteUrl =
  process.env.QUASAR_CONVEX_SITE_PUBLIC_URL ?? `https://${tailscaleHost}/quasar-api`;
const searchDataDir =
  process.env.QUASAR_SEARCH_DATA_DIR ?? join(quasarStateRoot(), "search.lance");
const localConvexConfigPath = join(quasarConvexLocalRoot(), "config.json");
const localConvexConfig = existsSync(localConvexConfigPath)
  ? JSON.parse(readFileSync(localConvexConfigPath, "utf8"))
  : {};
const actionSecret =
  process.env.QUASAR_ACTION_SECRET ??
  localConvexConfig.actionSecret ??
  spawnOutput("openssl", ["rand", "-hex", "32"]);
if (localConvexConfig.actionSecret === undefined && existsSync(localConvexConfigPath)) {
  writeFileSync(
    localConvexConfigPath,
    `${JSON.stringify({ ...localConvexConfig, actionSecret }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

const agents = [
  {
    label: "com.quasar.convex-local-backend",
    script: join(repoRoot, "scripts", "start-local-convex.mjs"),
    stdout: join(logsDir, "launchd-convex.out.log"),
    stderr: join(logsDir, "launchd-convex.err.log"),
  },
];

mkdirSync(launchAgentsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });
mkdirSync(quasarTmpDir, { recursive: true, mode: 0o700 });

for (const agent of agents) {
  const plistPath = join(launchAgentsDir, `${agent.label}.plist`);
  writeFileSync(plistPath, plist(agent), "utf8");

  spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
  run("launchctl", ["bootstrap", domain, plistPath]);
  run("launchctl", ["enable", `${domain}/${agent.label}`]);
  run("launchctl", ["kickstart", "-k", `${domain}/${agent.label}`]);
}

function plist(agent) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${agent.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${agent.script}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${nodeLtsBin}:${dirname(nodePath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${homeDir}</string>
    <key>USER</key>
    <string>${process.env.USER ?? "guilhermecastro"}</string>
    <key>TMPDIR</key>
    <string>${quasarTmpDir}</string>
    <key>QUASAR_HOME</key>
    <string>${quasarStateRoot()}</string>
    <key>QUASAR_CONFIG</key>
    <string>${quasarClientConfigPath()}</string>
    <key>QUASAR_CONVEX_TMP_ROOT</key>
    <string>${quasarTmpDir}</string>
    <key>QUASAR_TAILSCALE_HOST</key>
    <string>${tailscaleHost}</string>
    <key>QUASAR_CONVEX_PUBLIC_URL</key>
    <string>${publicConvexUrl}</string>
    <key>QUASAR_CONVEX_SITE_PUBLIC_URL</key>
    <string>${publicConvexSiteUrl}</string>
    <key>QUASAR_SEARCH_DATA_DIR</key>
    <string>${searchDataDir}</string>
    <key>QUASAR_REPO_ROOT</key>
    <string>${repoRoot}</string>
    <key>QUASAR_BUN_BIN</key>
    <string>${bunBin}</string>
    <key>QUASAR_ACTION_SECRET</key>
    <string>${actionSecret}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${agent.stdout}</string>
  <key>StandardErrorPath</key>
  <string>${agent.stderr}</string>
</dict>
</plist>
`;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function spawnOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}
