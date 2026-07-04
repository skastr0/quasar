#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
    ready: "GET /ready from the local server",
    health: "GET /health from the local server (liveness)",
    status: "GET /status from the local server; pass --lance for LanceDB stats",
    lance: "inspect all LanceDB tables and indexes directly inside the container",
    exec: "run a command inside the container after --",
    maintain: "run LanceDB maintenance inside the container, not through HTTP",
    materialize: "run embedding vector materialization through HTTP and write a proof receipt",
    "materialize-staging": "run non-live materialization proof in a one-off Docker container with the data volume mounted read-only; pass --staging-dir for a larger work disk",
    backup: "write ./quasar-truth-backup.tar with SQLite truth and machine identity",
  },
  examples: [
    "bun scripts/server-ops.mjs deploy",
    "bun scripts/server-ops.mjs status --lance",
    "bun scripts/server-ops.mjs lance",
    "bun scripts/server-ops.mjs maintain",
    "bun scripts/server-ops.mjs materialize --out docs/proofs/materialization-closure.json",
    "bun scripts/server-ops.mjs materialize-staging --out docs/proofs/materialize-staging-docker.json --staging-dir /Volumes/large/quasar-staging",
    "bun scripts/server-ops.mjs exec -- sh -lc 'ls -lah /data/quasar'",
  ],
};

if (command === "help" || command === "--help" || command === "-h") {
  printJson({ ok: true, ...usage });
  process.exit(0);
}

if (command !== "materialize" && command !== "materialize-staging") {
  requireFile(envFile, "copy platform/server/.env.example to platform/server/.env first");
  requireFile(composeFile, "missing server compose file");
}

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
  case "ready":
    if (rest.includes("--external")) await getJson("/ready");
    else containerGetJson("/ready");
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
    containerGetJson("/maintenance/run");
    break;
  case "materialize":
    materializeVectors();
    break;
  case "materialize-staging":
    materializeStaging();
    break;
  case "backup":
    backupTruth();
    break;
  default:
    fail(`unknown command: ${command}`);
}

function sh(script) {
  exec(["sh", "-lc", script]);
}

function lanceTables() {
  sh([
    "cd /app/packages/server",
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

function materializeVectors() {
  const serverUrl = optionValue("--server", process.env.QUASAR_SERVER_URL ?? `http://127.0.0.1:${process.env.QUASAR_PUBLISH_PORT ?? "7180"}`);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outPath = optionValue("--out", `docs/proofs/materialization-closure-${timestamp}.json`);
  const requiredProvider = optionValue("--require-provider", "local");
  const args = [
    "run",
    "packages/cli/src/cli.ts",
    "materialize-embedding-vectors",
    "--server",
    serverUrl,
    "--until-empty",
    "--require-provider",
    requiredProvider,
    "--out",
    outPath,
  ];
  for (const flag of ["--limit", "--max-batches", "--timeout-ms"]) {
    const value = optionValue(flag);
    if (value !== undefined) args.push(flag, value);
  }
  const result = spawnSync("bun", args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function materializeStaging() {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outPath = resolve(optionValue("--out", `docs/proofs/materialize-staging-docker-${timestamp}.json`));
  const outDir = dirname(outPath);
  const outFile = basename(outPath);
  const image = "quasar-server:staging-proof";
  const volume = optionValue("--volume", "quasar-server_quasar-data");
  const stagingDir = optionValue("--staging-dir");
  const stagingParent = stagingDir === undefined ? undefined : validateExternalStagingParent(stagingDir);
  const modelCacheDir = optionValue("--onnx-cache-dir", "/tmp/quasar-models");
  mkdirSync(outDir, { recursive: true });

  docker(["build", "-f", "platform/server/Dockerfile", "-t", image, "."], { rawCompose: false });
  const stagingRoot = stagingParent === undefined ? undefined : mkdtempSync(join(stagingParent, "quasar-materialize-staging-work-"));
  const proofDir = mkdtempSync(join(tmpdir(), "quasar-materialize-staging-proof-out-"));

  const runnerArgs = [
    "scripts/materialize-staging-proof.mjs",
    "--source-db",
    "/source/quasar.sqlite",
    "--out",
    `/proof/${outFile}`,
    "--onnx-cache-dir",
    modelCacheDir,
    "--cleanup",
  ];
  for (const flag of ["--limit", "--max-batches", "--timeout-ms", "--port", "--cache-namespace", "--embedding-model", "--embedding-dimensions", "--embedding-task"]) {
    const value = optionValue(flag);
    if (value !== undefined) runnerArgs.push(flag, value);
  }

  const dockerRunArgs = [
    "run",
    "--rm",
    "--name",
    `quasar-materialize-staging-${Date.now()}`,
    "--mount",
    `type=volume,source=${volume},target=/source,readonly`,
    "--mount",
    `type=bind,source=${proofDir},target=/proof`,
  ];
  if (stagingRoot !== undefined) {
    dockerRunArgs.push(
      "--mount",
      `type=bind,source=${stagingRoot},target=/staging`,
      "-e",
      "TMPDIR=/staging",
    );
  }
  dockerRunArgs.push(
    "--workdir",
    "/app",
    "-e",
    "NODE_ENV=production",
    "-e",
    "QUASAR_EMBEDDING_PROVIDER=local",
    image,
    "bun",
    ...runnerArgs,
  );

  let status = 0;
  let copiedReceipt = false;
  try {
    const result = dockerResult(dockerRunArgs, { rawCompose: false });
    status = result.status ?? 1;
    if (status === 0) {
      copyFileSync(join(proofDir, outFile), outPath);
      copiedReceipt = true;
    }
  } finally {
    rmSync(proofDir, { recursive: true, force: true });
    if (copiedReceipt && stagingRoot !== undefined) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  if (status !== 0) process.exit(status);
}

function validateExternalStagingParent(path) {
  const root = resolve(path);
  if (!existsSync(root)) fail(`--staging-dir does not exist: ${root}`);
  if (!statSync(root).isDirectory()) fail(`--staging-dir is not a directory: ${root}`);
  return root;
}

function exec(args) {
  docker(["exec", "-T", "server", ...args]);
}

function docker(args, options = {}) {
  const result = dockerResult(args, options);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function dockerResult(args, options = {}) {
  const rawCompose = options.rawCompose ?? true;
  const dockerArgs = rawCompose ? [...compose, ...args] : args;
  const env = options.injectShellSecrets ? withShellSecrets(process.env) : process.env;
  return spawnSync("docker", dockerArgs, { cwd: repoRoot, stdio: "inherit", env });
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
  for (const key of ["SYNTHETIC_API_KEY"]) {
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

function optionValue(flag, fallback) {
  const index = rest.indexOf(flag);
  if (index === -1) return fallback;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
  return value;
}

function requireFile(path, message) {
  if (!existsSync(path)) fail(`${message}: ${path}`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  printJson({ ok: false, error: message, ...usage });
  process.exit(2);
}
