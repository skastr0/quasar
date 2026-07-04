#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Database } from "bun:sqlite";

const repoRoot = resolve(import.meta.dir, "..");
const command = "materialize-staging-proof";
const args = process.argv.slice(2);

const generatedAt = new Date().toISOString().replaceAll(":", "-");

const usage = {
  command,
  description: "Snapshot a supplied SQLite truth DB, run the real server against the copy, and materialize local embedding vectors to a closure receipt.",
  usage: "bun scripts/materialize-staging-proof.mjs --source-db /path/to/quasar.sqlite [--out docs/proofs/materialize-staging-proof.json]",
  options: [
    "--source-db path              Required SQLite truth DB to snapshot with VACUUM INTO.",
    "--out path                    Optional wrapped proof report. Defaults under docs/proofs/.",
    "--cache-namespace name        Optional active embedding cache namespace override for the staged server.",
    "--embedding-model name        Optional QUASAR_EMBEDDING_MODEL override.",
    "--embedding-dimensions n      Optional QUASAR_EMBEDDING_DIMENSIONS override.",
    "--embedding-task name         Optional QUASAR_EMBEDDING_TASK override.",
    "--onnx-cache-dir path         Optional local ONNX/Hugging Face model cache directory.",
    "--limit n                     Optional materialization batch size.",
    "--max-batches n               Optional CLI loop cap.",
    "--timeout-ms n                Optional HTTP timeout for each CLI request.",
    "--port n                      Optional local staging server port.",
    "--cleanup                     Delete the generated temp staging directory after a successful run.",
  ],
};

const optionValue = (flag, fallback) => {
  const index = args.lastIndexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`, { flag }, 2);
  return value;
};

const hasFlag = (flag) => args.includes(flag);
const valueFlags = new Set([
  "--source-db",
  "--out",
  "--cache-namespace",
  "--embedding-model",
  "--embedding-dimensions",
  "--embedding-task",
  "--onnx-cache-dir",
  "--limit",
  "--max-batches",
  "--timeout-ms",
  "--port",
]);
const booleanFlags = new Set(["--cleanup", "--help"]);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (!arg.startsWith("--")) continue;
  if (valueFlags.has(arg)) {
    index += 1;
    continue;
  }
  if (booleanFlags.has(arg)) continue;
  fail("unknown option", { flag: arg }, 2);
}

const positiveIntOption = (flag, fallback) => {
  const raw = optionValue(flag);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  fail(`${flag} must be a positive integer`, { flag, received: raw }, 2);
};

const quoteSqlString = (value) => `'${value.replaceAll("'", "''")}'`;

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, details = {}, exitCode = 1) {
  printJson({ ok: false, command, error: { message, ...details }, usage });
  process.exit(exitCode);
}

if (hasFlag("--help")) {
  printJson({ ok: true, ...usage });
  process.exit(0);
}

const sourceDb = optionValue("--source-db");
if (sourceDb === undefined || sourceDb.trim() === "") {
  fail("missing required --source-db", {}, 2);
}

const resolvedSourceDb = resolve(sourceDb);
if (!existsSync(resolvedSourceDb)) {
  fail("source database does not exist", { sourceDb: resolvedSourceDb }, 2);
}

const workDir = mkdtempSync(join(tmpdir(), "quasar-materialize-staging-"));
const workDb = join(workDir, "quasar.sqlite");
const searchDir = join(workDir, "search.lance");
const homeDir = join(workDir, "home");
const cliReceiptPath = join(workDir, "materialization-closure.json");
const outPath = resolve(optionValue("--out", `docs/proofs/materialize-staging-proof-${generatedAt}.json`));
const port = positiveIntOption("--port", 20_000 + Math.floor(Math.random() * 30_000));
const baseUrl = `http://127.0.0.1:${port}`;
const startedAt = new Date().toISOString();
const started = performance.now();

if (existsSync(workDb)) {
  fail("work database already exists", { workDb }, 2);
}
if (hasFlag("--cleanup") && pathIsInside(outPath, workDir)) {
  fail("--cleanup would remove the requested --out path", { outPath, workDir }, 2);
}
if (hasFlag("--cleanup") && existsSync(workDir) && readdirSync(workDir).length > 0) {
  fail("--cleanup requires a fresh or empty work directory", { workDir }, 2);
}

mkdirSync(workDir, { recursive: true });
mkdirSync(searchDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });

const snapshot = new Database(resolvedSourceDb, { readonly: true });
try {
  snapshot.exec(`VACUUM INTO ${quoteSqlString(workDb)}`);
} finally {
  snapshot.close();
}

const serverEnv = {
  ...process.env,
  QUASAR_LOCAL_HOME: homeDir,
  QUASAR_LOCAL_SQLITE: workDb,
  QUASAR_SEARCH_DATA_DIR: searchDir,
  QUASAR_EMBEDDING_PROVIDER: "local",
  QUASAR_LOCAL_PORT: String(port),
};

const optionalEnv = [
  ["--cache-namespace", "QUASAR_EMBEDDING_CACHE_NAMESPACE"],
  ["--embedding-model", "QUASAR_EMBEDDING_MODEL"],
  ["--embedding-dimensions", "QUASAR_EMBEDDING_DIMENSIONS"],
  ["--embedding-task", "QUASAR_EMBEDDING_TASK"],
  ["--onnx-cache-dir", "QUASAR_EMBEDDING_MODEL_CACHE_DIR"],
];
for (const [flag, envName] of optionalEnv) {
  const value = optionValue(flag);
  if (value !== undefined) serverEnv[envName] = value;
}

const server = Bun.spawn([
  "bun",
  "packages/server/src/main.ts",
  "--port",
  String(port),
], {
  cwd: repoRoot,
  env: serverEnv,
  stdout: "pipe",
  stderr: "pipe",
});

const textFromStream = async (stream) => new Response(stream).text();
const serverStdoutPromise = textFromStream(server.stdout);
const serverStderrPromise = textFromStream(server.stderr);
let materializeStdout = "";
let materializeStderr = "";
let materializeExitCode = 1;
let runError;

try {
  await waitForHealth(`${baseUrl}/health`, positiveIntOption("--timeout-ms", 60_000), workDb);

  const cliArgs = [
    "run",
    "packages/cli/src/cli.ts",
    "materialize-embedding-vectors",
    "--server",
    baseUrl,
    "--until-empty",
    "--require-provider",
    "local",
    "--out",
    cliReceiptPath,
  ];
  for (const flag of ["--limit", "--max-batches", "--timeout-ms"]) {
    const value = optionValue(flag);
    if (value !== undefined) cliArgs.push(flag, value);
  }

  const materialize = Bun.spawn(["bun", ...cliArgs], {
    cwd: repoRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  [materializeStdout, materializeStderr, materializeExitCode] = await Promise.all([
    textFromStream(materialize.stdout),
    textFromStream(materialize.stderr),
    materialize.exited,
  ]);
} catch (error) {
  runError = error;
} finally {
  server.kill();
}

const [serverStdout, serverStderr] = await Promise.all([
  serverStdoutPromise,
  serverStderrPromise,
  server.exited.catch(() => 1),
]).then(([stdout, stderr]) => [stdout, stderr]);

if (runError !== undefined) {
  fail(runError instanceof Error ? runError.message : "staged materialization setup failed", {
    error: runError instanceof Error ? runError.message : String(runError),
    server: { stdout: serverStdout, stderr: serverStderr },
    workDir,
    workDb,
    searchDir,
  });
}

if (materializeExitCode !== 0) {
  fail("staged materialization failed", {
    exitCode: materializeExitCode,
    stdout: materializeStdout,
    stderr: materializeStderr,
    server: { stdout: serverStdout, stderr: serverStderr },
    workDir,
    workDb,
    searchDir,
  });
}

let materialization;
try {
  materialization = JSON.parse(materializeStdout);
} catch (error) {
  fail("materialization command did not emit JSON", {
    stdout: materializeStdout,
    stderr: materializeStderr,
    error: error instanceof Error ? error.message : String(error),
    workDir,
  });
}

const report = {
  ok: true,
  command,
  data: {
    sourceDb: resolvedSourceDb,
    workDir,
    workDb,
    searchDir,
    receiptPath: cliReceiptPath,
    provider: "local",
    server: { url: baseUrl },
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    materialization,
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
if (hasFlag("--cleanup")) {
  rmSync(workDir, { recursive: true, force: true });
}
printJson({ ...report, outPath });

function pathIsInside(child, parent) {
  const childRelativeToParent = relative(parent, child);
  return childRelativeToParent === "" || (!childRelativeToParent.startsWith("..") && !isAbsolute(childRelativeToParent));
}

async function waitForHealth(url, timeoutMs, expectedSqlite) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        const observedSqlite = body?.data?.sqlite;
        if (observedSqlite !== expectedSqlite) {
          throw new Error(`staging server health SQLite path mismatch: expected ${expectedSqlite}, observed ${String(observedSqlite)}`);
        }
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("staging server health SQLite path mismatch")) {
        throw error;
      }
      // Server is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error(`staging server did not become healthy: ${url} after ${timeoutMs}ms`);
}
