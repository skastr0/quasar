#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const command = process.argv[2] ?? "install";
const label = "com.quasar.local-server-sync";
const home = homedir();
const domain = `gui/${process.getuid?.() ?? spawnOutput("id", ["-u"])}`;
const launchAgentsDir = resolve(home, "Library/LaunchAgents");
const plistPath = resolve(launchAgentsDir, `${label}.plist`);
const logsDir = resolve(repoRoot, "logs");
const lockDir = resolve(logsDir, "local-server-sync.lock");
const bunBin = process.env.QUASAR_BUN_BIN ?? (process.versions.bun ? process.execPath : spawnOutput("which", ["bun"]));
const intervalSeconds = Number(process.env.QUASAR_LOCAL_SERVER_SYNC_INTERVAL_SECONDS ?? "900");
const syncCommand = `lock=${shellQuote(lockDir)}; if mkdir "$lock" 2>/dev/null; then cleanup() { rmdir "$lock"; }; trap cleanup EXIT INT TERM; ${shellQuote(bunBin)} run local-server:sync-tick; code=$?; cleanup; trap - EXIT INT TERM; exit "$code"; else echo "quasar local-server sync already running; skipping"; fi`;

switch (command) {
  case "install":
    requireFile(resolve(repoRoot, "platform/local-server/.env"), "copy platform/local-server/.env.example to platform/local-server/.env first");
    mkdirSync(launchAgentsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(plistPath, plist(), { encoding: "utf8", mode: 0o600 });
    spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
    run("launchctl", ["bootstrap", domain, plistPath]);
    run("launchctl", ["enable", `${domain}/${label}`]);
    run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
    print({ ok: true, command, label, plistPath, intervalSeconds });
    break;
  case "uninstall":
    spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
    if (existsSync(plistPath)) unlinkSync(plistPath);
    print({ ok: true, command, label, plistPath });
    break;
  case "status": {
    const result = spawnSync("launchctl", ["print", `${domain}/${label}`], { encoding: "utf8" });
    print({
      ok: result.status === 0,
      command,
      label,
      installed: existsSync(plistPath),
      loaded: result.status === 0,
      output: result.status === 0 ? result.stdout : result.stderr,
    });
    process.exit(result.status === 0 ? 0 : 1);
  }
  default:
    print({ ok: false, error: `unknown command: ${command}`, commands: ["install", "uninstall", "status"] });
    process.exit(2);
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${xml(syncCommand)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(`${dirname(bunBin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
    <key>HOME</key>
    <string>${xml(home)}</string>
    <key>USER</key>
    <string>${xml(process.env.USER ?? "guilhermecastro")}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${Number.isInteger(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 900}</integer>
  <key>StandardOutPath</key>
  <string>${xml(resolve(logsDir, "local-server-sync.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(resolve(logsDir, "local-server-sync.err.log"))}</string>
</dict>
</plist>
`;
}

function requireFile(path, message) {
  if (!existsSync(path)) throw new Error(`${message}: ${path}`);
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

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
