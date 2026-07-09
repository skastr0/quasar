#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { embeddingProfileFromEnv } from "./embeddingProfiles";
import { makeLocalOnnxEmbedder } from "./localOnnxEmbeddings";
import { measureEmbeddingParity, runSqliteFirstProof, type SqliteFirstProofReport } from "./sqliteFirstProof";

const args = process.argv.slice(2);

const writeStdout = (text: string): void => {
  process.stdout.write(text);
};

const writeStderr = (text: string): void => {
  process.stderr.write(text);
};

const valueFor = (name: string, fallback?: string): string | undefined => {
  const index = args.lastIndexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    writeStderr(`Missing value for ${name}\n`);
    process.exit(1);
  }
  return value;
};

const hasFlag = (name: string): boolean => args.includes(name);

const numberFor = (name: string, fallback: number): number => {
  const raw = valueFor(name);
  if (raw === undefined) return fallback;
  if (raw === "all") return Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const optionalPositiveIntFor = (name: string): number | undefined => {
  const raw = valueFor(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const optionalUnitNumberFor = (name: string): number | undefined => {
  const raw = valueFor(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
};

const usage = () => {
  writeStdout(`Usage:
  bun run proof:sqlite-first --source-db /path/to/quasar.sqlite [--work-db /tmp/proof.sqlite] [--out docs/proofs/sqlite-first-proof.json]

Options:
  --source-db       Required. SQLite truth database to snapshot with VACUUM INTO.
  --work-db         Optional. Destination proof DB. Must not already exist.
  --out             Optional JSON report path. Defaults under docs/proofs/.
  --query           Repeatable FTS query. Defaults to a small built-in set.
  --fts-samples     Repeated filtered FTS samples per query. Use 60 for the p95/p99 gate. Default 1.
  --filter-project-key Optional project_key filter for filtered FTS timing. Defaults to the most common project.
  --filter-role     Optional role filter for filtered FTS timing. Defaults to assistant.
  --cache-namespace Override the embedding cache namespace inspected for saved vectors.
  --vector-limit    Rows to materialize into proof_message_vectors. Default 20000; use "all" for all rows.
  --scan-limit      Rows to exact-scan. Defaults to vector-limit.
  --scan-samples    Repeated exact-scan samples. Use 60 for the p95/p99 gate. Default 1.
  --scan-kernel     Exact-scan kernel: usearch or pure-js. Default usearch.
  --scan-threads    Threads for the usearch exact-scan kernel. Default 1.
  --parity-sample   Optional local-vs-cached parity sample size. Use at least 1000 for the QSR-229 gate.
  --parity-threshold Required with --parity-sample. Cosine threshold in (0, 1].
  --parity-batch-size Local ONNX batch size for parity. Default 32.
  --onnx-cache-dir  Optional Hugging Face/ONNX model cache directory.

The source database is opened read-only. FTS and vector proof tables are created only in the work DB.
Parity reads cached vectors from the work DB snapshot and embeds the sampled text locally; it does not write to either database.
`);
};

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const sourceDb = valueFor("--source-db");
if (sourceDb === undefined || sourceDb.trim() === "") {
  usage();
  writeStderr("Missing required --source-db\n");
  process.exit(1);
}

const generatedAt = new Date().toISOString().replaceAll(":", "-");
const workDb = valueFor("--work-db", join(tmpdir(), `quasar-sqlite-first-proof-${generatedAt}.sqlite`));
const outPath = valueFor("--out", `docs/proofs/sqlite-first-proof-${generatedAt}.json`)!;
const queries = args.flatMap((arg, index) => (arg === "--query" && args[index + 1] !== undefined ? [args[index + 1]!] : []));
const ftsBenchmarkSamples = numberFor("--fts-samples", 1);
const ftsFilterProjectKey = valueFor("--filter-project-key");
const ftsFilterRole = valueFor("--filter-role");
const vectorLimit = numberFor("--vector-limit", 20_000);
const exactScanLimit = numberFor("--scan-limit", vectorLimit);
const exactScanSamples = numberFor("--scan-samples", 1);
const exactScanKernel = valueFor("--scan-kernel", "usearch");
const exactScanThreads = numberFor("--scan-threads", 1);
const paritySample = optionalPositiveIntFor("--parity-sample");
const parityThreshold = optionalUnitNumberFor("--parity-threshold");
const parityBatchSize = optionalPositiveIntFor("--parity-batch-size") ?? 32;
const baseProfile = embeddingProfileFromEnv();
const profile = {
  ...baseProfile,
  cacheNamespace: valueFor("--cache-namespace", baseProfile.cacheNamespace)!,
};

if (paritySample !== undefined && parityThreshold === undefined) {
  usage();
  writeStderr("Missing required --parity-threshold for --parity-sample\n");
  process.exit(1);
}

if (exactScanKernel !== "usearch" && exactScanKernel !== "pure-js") {
  usage();
  writeStderr("Invalid --scan-kernel; expected usearch or pure-js\n");
  process.exit(1);
}

let report: SqliteFirstProofReport = runSqliteFirstProof({
  sourceDb: resolve(sourceDb),
  workDb: resolve(workDb!),
  profile,
  queries: queries.length > 0 ? queries : undefined,
  ftsBenchmarkSamples,
  ftsFilterProjectKey,
  ftsFilterRole,
  vectorLimit,
  exactScanLimit,
  exactScanSamples,
  exactScanKernel,
  exactScanThreads,
});

if (paritySample !== undefined && parityThreshold !== undefined) {
  Bun.gc(true);
  const localProfile = {
    ...profile,
    cacheNamespace: valueFor(
      "--parity-local-cache-namespace",
      `local-proof:${profile.model}:${profile.dimensions}:${profile.task}`,
    )!,
  };
  const db = new Database(report.workDb, { readonly: true });
  try {
    report = {
      ...report,
      embeddingParity: await measureEmbeddingParity(
        db,
        profile,
        localProfile,
        makeLocalOnnxEmbedder(localProfile, { cacheDir: valueFor("--onnx-cache-dir") }),
        {
          sampleSize: paritySample,
          threshold: parityThreshold,
          batchSize: parityBatchSize,
        },
      ),
    };
  } finally {
    db.close();
  }
}

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
writeStdout(`${JSON.stringify({ ok: true, command: "sqlite-first-proof", outPath, workDb: report.workDb }, null, 2)}\n`);
