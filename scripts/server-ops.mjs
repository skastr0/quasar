#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "..");
const envFile = resolve(repoRoot, "platform/server/.env");
const composeFile = resolve(repoRoot, "platform/server/compose.yaml");
const command = process.argv[2] ?? "help";
const rest = process.argv.slice(3);

const compose = ["compose", "--env-file", envFile, "-f", composeFile];

const usage = {
  commands: {
    deploy: "build/recreate the Docker server service",
    up: "start the Docker server service without force recreate",
    down: "stop the Docker server service",
    restart: "restart the running service",
    ps: "show compose service state",
    logs: "follow server logs; pass --no-follow to print once",
    health: "GET /health from the local server",
    status: "GET /status from the local server; pass --lance for LanceDB stats",
    lance: "inspect all LanceDB tables and indexes directly inside the container",
    exec: "run a command inside the container after --",
    maintain: "run LanceDB maintenance inside the container, not through HTTP",
    backup: "write ./quasar-truth-backup.tar with SQLite truth and machine identity",
  },
  examples: [
    "bun scripts/server-ops.mjs deploy",
    "bun scripts/server-ops.mjs status --lance",
    "bun scripts/server-ops.mjs lance",
    "bun scripts/server-ops.mjs maintain --vector true --optimize true",
    "bun scripts/server-ops.mjs exec -- sh -lc 'ls -lah /data/quasar'",
  ],
};

if (command === "help" || command === "--help" || command === "-h") {
  printJson({ ok: true, ...usage });
  process.exit(0);
}

requireFile(envFile, "copy platform/server/.env.example to platform/server/.env first");
requireFile(composeFile, "missing server compose file");

switch (command) {
  case "deploy":
    docker(["up", "-d", "--build", "--force-recreate", "server"], { injectShellSecrets: true });
    break;
  case "up":
    docker(["up", "-d", "--build", "server"], { injectShellSecrets: true });
    break;
  case "down":
    docker(["down"]);
    break;
  case "restart":
    docker(["restart", "server"]);
    break;
  case "ps":
    docker(["ps"]);
    break;
  case "logs":
    docker(rest.includes("--no-follow") ? ["logs", "--tail=200", "server"] : ["logs", "-f", "--tail=200", "server"]);
    break;
  case "health":
    if (rest.includes("--external")) await getJson("/health");
    else containerGetJson("/health");
    break;
  case "status":
    if (rest.includes("--external")) await getJson(rest.includes("--lance") ? "/status?lance=true" : "/status");
    else containerGetJson(rest.includes("--lance") ? "/status?lance=true" : "/status");
    break;
  case "lance":
    lanceTables();
    break;
  case "exec": {
    const separator = rest.indexOf("--");
    const args = separator === -1 ? rest : rest.slice(separator + 1);
    if (args.length === 0) fail("exec requires a command after --");
    exec(args);
    break;
  }
  case "maintain":
    cli(["operator-maintain", ...(rest.length === 0 ? ["--vector", "true", "--optimize", "true"] : rest)]);
    break;
  case "backup":
    backupTruth();
    break;
  default:
    fail(`unknown command: ${command}`);
}

function cli(args) {
  sh(["cd /app", ["bun", "packages/cli/src/cli.ts", ...args.map(shellQuote)].join(" ")].join(" && "));
}

function sh(script) {
  exec(["sh", "-lc", script]);
}

function lanceTables() {
  sh([
    "cd /app/packages/search",
    "bun -e 'import * as lancedb from \"@lancedb/lancedb\"; const db = await lancedb.connect(process.env.QUASAR_SEARCH_DATA_DIR); const tables = []; for (const name of await db.tableNames()) { const table = await db.openTable(name); tables.push({ name, rows: await table.countRows(), indices: (await table.listIndices()).map((index) => ({ name: index.name, type: index.indexType, columns: index.columns, indexedRows: index.numIndexedRows, unindexedRows: index.numUnindexedRows })) }); } console.log(JSON.stringify({ ok: true, command: \"lance\", data: { tables } }, null, 2));'",
  ].join(" && "));
}

function backupTruth() {
  sh([
    "set -eu",
    "rm -rf /tmp/quasar-truth-backup /tmp/quasar-truth-backup.tar",
    "mkdir -p /tmp/quasar-truth-backup",
    "cd /app/packages/server",
    "bun -e 'import { Database } from \"bun:sqlite\"; const db = new Database(process.env.QUASAR_LOCAL_SQLITE); db.exec(\"VACUUM INTO \\\"/tmp/quasar-truth-backup/quasar.sqlite\\\"\"); db.close();'",
    "cp /data/quasar/machine.json /tmp/quasar-truth-backup/machine.json",
    "tar -cf /tmp/quasar-truth-backup.tar -C /tmp/quasar-truth-backup .",
    "rm -rf /tmp/quasar-truth-backup",
  ].join("\n"));
  docker(["cp", "server:/tmp/quasar-truth-backup.tar", "./quasar-truth-backup.tar"]);
  sh("rm -f /tmp/quasar-truth-backup.tar");
}

function exec(args) {
  docker(["exec", "-T", "server", ...args]);
}

function docker(args, options = {}) {
  const rawCompose = options.rawCompose ?? true;
  const dockerArgs = rawCompose ? [...compose, ...args] : args;
  const env = options.injectShellSecrets ? withShellSecrets(process.env) : process.env;
  const result = spawnSync("docker", dockerArgs, { cwd: repoRoot, stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function getJson(path) {
  const base = process.env.QUASAR_SERVER_URL ?? `http://127.0.0.1:${process.env.QUASAR_LOCAL_PORT ?? "6180"}`;
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  const response = await fetch(url);
  const body = await response.text();
  try {
    printJson(JSON.parse(body));
  } catch {
    process.stdout.write(`${body}\n`);
  }
  if (!response.ok) process.exit(1);
}

function containerGetJson(path) {
  const url = `http://127.0.0.1:${process.env.QUASAR_LOCAL_PORT ?? "6180"}${path}`;
  const dockerArgs = [...compose, "exec", "-T", "server", "curl", "-fsS", url];
  const result = spawnSync("docker", dockerArgs, { cwd: repoRoot, encoding: "utf8", env: process.env });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) {
    try {
      printJson(JSON.parse(result.stdout));
    } catch {
      process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    }
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function withShellSecrets(env) {
  const next = { ...env };
  for (const key of ["SYNTHETIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) {
    if (next[key]?.trim()) continue;
    const value = readInteractiveShellEnv(key);
    if (value) next[key] = value;
  }
  return next;
}

function readInteractiveShellEnv(key) {
  const result = spawnSync("zsh", ["-ic", `printf %s \"$${key}\"`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function requireFile(path, message) {
  if (!existsSync(path)) fail(`${message}: ${path}`);
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  printJson({ ok: false, error: message, ...usage });
  process.exit(2);
}
