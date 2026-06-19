#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
const lockInfoPath = resolve(lockDir, "info.json");
const bunBin = process.env.QUASAR_BUN_BIN ?? (process.versions.bun ? process.execPath : spawnOutput("which", ["bun"]));
const intervalSeconds = Number(process.env.QUASAR_LOCAL_SERVER_SYNC_INTERVAL_SECONDS ?? "900");
const staleLockSeconds = Number(process.env.QUASAR_LOCAL_SERVER_SYNC_STALE_LOCK_SECONDS ?? "3600");

switch (command) {
  case "run":
    runSyncTick();
    break;
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
    print({ ok: false, error: `unknown command: ${command}`, commands: ["install", "uninstall", "status", "run"] });
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
    <string>${xml(bunBin)}</string>
    <string>${xml(resolve(repoRoot, "scripts/install-local-server-sync.mjs"))}</string>
    <string>run</string>
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

function runSyncTick() {
  mkdirSync(logsDir, { recursive: true });
  const acquired = acquireLock();
  if (!acquired) {
    print({ ok: true, command, skipped: true, reason: "already_running", lockDir });
    return;
  }

  const cleanup = () => {
    rmSync(lockDir, { recursive: true, force: true });
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  const result = spawnSync(bunBin, ["run", "local-server:sync-tick"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  cleanup();
  process.exit(result.status ?? (result.signal === null ? 1 : 128));
}

function acquireLock() {
  try {
    mkdirSync(lockDir);
    writeFileSync(lockInfoPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    return true;
  } catch {
    if (isStaleLock()) {
      rmSync(lockDir, { recursive: true, force: true });
      try {
        mkdirSync(lockDir);
        writeFileSync(lockInfoPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), recoveredStaleLock: true }, null, 2));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function isStaleLock() {
  const maxAgeSeconds = Number.isInteger(staleLockSeconds) && staleLockSeconds > 0 ? staleLockSeconds : 3600;
  try {
    const info = JSON.parse(readFileSync(lockInfoPath, "utf8"));
    const startedAt = Date.parse(info.startedAt);
    return Number.isFinite(startedAt) && Date.now() - startedAt > maxAgeSeconds * 1000;
  } catch {
    return false;
  }
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

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
