import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  quasarClientConfigPath,
  quasarConvexBackupRoot,
  quasarConvexLocalRoot,
  quasarStateRoot,
} from "./quasar-state.mjs";

const action = process.argv[2] ?? "status";
const repoRoot = resolve(process.cwd());
const uid = process.getuid?.() ?? Number(spawnOutput("id", ["-u"]));
const domain = `gui/${uid}`;
const label = "com.quasar.convex-local-backend";
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const localRoot = quasarConvexLocalRoot();
const composeFile = join(repoRoot, "platform", "convex", "compose.yaml");
const composeEnv = join(repoRoot, "platform", "convex", ".env");

if (!["status", "park"].includes(action)) {
  console.error("Usage: bun scripts/park-quasar-convex.mjs [status|park]");
  process.exit(2);
}

if (action === "status") {
  printJson({ action, ...inventory() });
  process.exit(0);
}

const operations = [];
if (existsSync(plist)) {
  operations.push(runOptional("launchctl", ["bootout", domain, plist]));
  operations.push(runOptional("launchctl", ["disable", `${domain}/${label}`]));
} else {
  operations.push({ command: "launchctl", skipped: true, reason: `missing ${plist}` });
}

if (existsSync(composeFile) && existsSync(composeEnv)) {
  operations.push(
    runOptional("docker", ["compose", "--env-file", composeEnv, "-f", composeFile, "stop"]),
  );
} else {
  operations.push({ command: "docker compose stop", skipped: true, reason: "platform/convex compose env not present" });
}

printJson({ action, operations, ...inventory() });

function inventory() {
  return {
    launchd: {
      label,
      plist,
      plistExists: existsSync(plist),
      loaded: launchdLoaded(),
    },
    dockerCompose: {
      composeFile,
      envFile: composeEnv,
      composeFileExists: existsSync(composeFile),
      envFileExists: existsSync(composeEnv),
    },
    paths: {
      quasarHome: quasarStateRoot(),
      clientConfig: quasarClientConfigPath(),
      convexLocalRoot: localRoot,
      convexConfig: join(localRoot, "config.json"),
      convexSqlite: join(localRoot, "convex_local_backend.sqlite3"),
      convexStorage: join(localRoot, "convex_local_storage"),
      convexBackups: quasarConvexBackupRoot(),
      launchdStdout: join(repoRoot, "logs", "launchd-convex.out.log"),
      launchdStderr: join(repoRoot, "logs", "launchd-convex.err.log"),
    },
  };
}

function launchdLoaded() {
  const result = spawnSync("launchctl", ["print", `${domain}/${label}`], { encoding: "utf8" });
  return result.status === 0;
}

function runOptional(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function spawnOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
