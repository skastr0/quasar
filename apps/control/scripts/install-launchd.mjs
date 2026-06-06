import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  quasarConvexPublicUrl,
  quasarConvexSitePublicUrl,
  quasarTailscaleHost,
} from "./quasar-state.mjs";

const repoRoot = process.cwd();
const nodePath = process.execPath;
const homeDir = homedir();
const launchAgentsDir = join(homeDir, "Library", "LaunchAgents");
const logsDir = join(repoRoot, "logs");
const tmpDir = join(homeDir, ".quasar-control", "tmp");
const domain = `gui/${process.getuid?.() ?? spawnOutput("id", ["-u"])}`;
const host = quasarTailscaleHost();
const publicConvexUrl = quasarConvexPublicUrl();
const publicConvexSiteUrl = quasarConvexSitePublicUrl();

const agents = [
  {
    label: "com.quasar-control.convex-local-backend",
    script: join(repoRoot, "scripts", "start-local-convex.mjs"),
    stdout: join(logsDir, "launchd-convex.out.log"),
    stderr: join(logsDir, "launchd-convex.err.log"),
  },
  {
    label: "com.quasar-control.web",
    script: join(repoRoot, "scripts", "serve-next.mjs"),
    stdout: join(logsDir, "launchd-web.out.log"),
    stderr: join(logsDir, "launchd-web.err.log"),
  },
];

mkdirSync(launchAgentsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

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
    <string>${dirname(nodePath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${homeDir}</string>
    <key>USER</key>
    <string>${process.env.USER ?? "quasar"}</string>
    <key>TMPDIR</key>
    <string>${tmpDir}</string>
    <key>QUASAR_CONVEX_TMP_ROOT</key>
    <string>${tmpDir}</string>
    <key>QUASAR_TAILSCALE_HOST</key>
    <string>${host}</string>
    <key>QUASAR_CONVEX_PUBLIC_URL</key>
    <string>${publicConvexUrl}</string>
    <key>QUASAR_CONVEX_SITE_PUBLIC_URL</key>
    <string>${publicConvexSiteUrl}</string>
    <key>QUASAR_WEB_HOST</key>
    <string>${process.env.QUASAR_WEB_HOST ?? "127.0.0.1"}</string>
    <key>QUASAR_WEB_PORT</key>
    <string>${process.env.QUASAR_WEB_PORT ?? "5177"}</string>
    <key>NEXT_PUBLIC_CONVEX_URL</key>
    <string>${publicConvexUrl}</string>
    <key>NEXT_PUBLIC_CONVEX_SITE_URL</key>
    <string>${publicConvexSiteUrl}</string>
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
