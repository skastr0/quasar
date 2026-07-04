#!/usr/bin/env bun
// Permanent kernel-gate bench for the resident vector matrix (D7 hard gates).
//
// Generates a synthetic message_vectors corpus (default 700k x 768 random
// f16) into a throwaway SQLite file, boot-loads it through the REAL
// vectorMatrix loader, and enforces the receipted gates:
//   - boot matrix load          < 5s
//   - process RSS after load    < 4GB
//   - unfiltered scan p95       < 60ms   (default 60 samples)
//   - filtered scan p95         < 60ms   (~10% scope match, in-matrix
//                                         dictionary-code mask + scan — no
//                                         SQL, no store round trip)
// Writes the raw numbers to --out (default docs/proofs/) and exits non-zero
// when any gate fails.
//
// Usage: bun scripts/matrix-kernel-bench.ts [--rows N] [--dims N]
//        [--samples N] [--db path] [--out path] [--keep-db] [--reuse-db]
//
// --reuse-db skips generation when --db already holds the corpus (pair with
// --keep-db from a prior run): that measures a settled boot — the realistic
// case — instead of one racing the OS writeback of the freshly written file.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";

import { makeEmbeddingProfile } from "../packages/server/src/embeddingProfiles";
import { LocalStore, makeLocalStoreLayer } from "../packages/server/src/store";
import { float32ToFloat16Bits } from "../packages/server/src/vectorBlob";
import { loadNativeSimsimd } from "../packages/server/src/vectorKernel";
import { makeVectorMatrixLayer, VectorMatrix } from "../packages/server/src/vectorMatrix";

const repoRoot = resolve(import.meta.dir, "..");

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const intArg = (name: string, fallback: number): number => {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const ROWS = intArg("--rows", 700_000);
const DIMS = intArg("--dims", 768);
const SAMPLES = intArg("--samples", 60);
const KEEP_DB = process.argv.includes("--keep-db");
const OUT = resolve(repoRoot, argValue("--out") ?? "docs/proofs/matrix-kernel-bench-2026-07-04.json");
const EXPLICIT_DB = argValue("--db");
const DB_PATH = EXPLICIT_DB ?? join(mkdtempSync(join(tmpdir(), "quasar-matrix-bench-")), "bench.sqlite");

const MODEL = "bench-matrix-model";
const HOT_PROJECT = "benchhot";
const ROW_BYTES = DIMS * 2;

const GATE_LOAD_MS = 5_000;
const GATE_RSS_BYTES = 4 * 1024 * 1024 * 1024;
const GATE_SCAN_MS = 60;

const quantile = (sortedValues: readonly number[], q: number): number => {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(q * sortedValues.length) - 1));
  return sortedValues[index] ?? 0;
};

const timingStats = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    samples: sorted.length,
    minMs: round(sorted[0] ?? 0),
    medianMs: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    p99Ms: round(quantile(sorted, 0.99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
};

const makeRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff - 0.5;
  };
};

const randomVector = (random: () => number): number[] =>
  Array.from({ length: DIMS }, () => random());

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event: `matrix_bench.${event}`, at: new Date().toISOString(), ...fields }));

// --- 0. native kernel present (self-heals the darwin build) ---
const ensure = spawnSync("bun", [join(repoRoot, "scripts", "ensure-simsimd-native.mjs")], { stdio: ["ignore", "inherit", "inherit"] });
if (ensure.status !== 0) {
  console.error(JSON.stringify({ ok: false, error: "ensure-simsimd-native failed" }));
  process.exit(1);
}
const native = loadNativeSimsimd();
if (native === undefined) {
  console.error(JSON.stringify({ ok: false, error: "native simsimd kernel unavailable; gates are meaningless on the js fallback" }));
  process.exit(1);
}
const simsimdVersion = (JSON.parse(
  readFileSync(join(repoRoot, "packages/server/node_modules/simsimd/package.json"), "utf8"),
) as { version: string }).version;

// --- 1. generate the synthetic corpus ---
const REUSE_DB = process.argv.includes("--reuse-db") && EXPLICIT_DB !== undefined && existsSync(DB_PATH);
log("generate.start", { rows: ROWS, dims: DIMS, db: DB_PATH, reused: REUSE_DB });
const generateStarted = performance.now();
if (!REUSE_DB) {
  // Real store migration owns the schema; raw inserts fill message_vectors.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* LocalStore;
      }).pipe(Effect.provide(makeLocalStoreLayer(DB_PATH))),
    ),
  );
  const db = new Database(DB_PATH);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
    const insert = db.prepare(
      `INSERT OR REPLACE INTO message_vectors(model, modality, session_id, seq, role, project_key, provider, content_hash, document_hash, dimensions, encoding, vector_blob, created_at, updated_at)
       VALUES (?, 'text', ?, ?, 'assistant', ?, 'bench', ?, ?, ?, 'f16le', ?, ?, ?)`,
    );
    const at = new Date().toISOString();
    const random = makeRandom(0x5eed1234);
    const rowBits = new Uint16Array(DIMS);
    const rowBytes = new Uint8Array(rowBits.buffer);
    const BATCH = 10_000;
    const insertBatch = db.transaction((start: number, end: number) => {
      for (let index = start; index < end; index += 1) {
        for (let dim = 0; dim < DIMS; dim += 1) {
          rowBits[dim] = float32ToFloat16Bits(random());
        }
        insert.run(
          MODEL,
          `bench:s${Math.floor(index / 128)}`,
          index % 128,
          index % 10 === 0 ? HOT_PROJECT : `bench-p${index % 37}`,
          `content-${index}`,
          `doc-${index}`,
          DIMS,
          rowBytes,
          at,
          at,
        );
      }
    });
    for (let start = 0; start < ROWS; start += BATCH) {
      insertBatch(start, Math.min(ROWS, start + BATCH));
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}
const generateMs = Math.round(performance.now() - generateStarted);
const dbBytes = statSync(DB_PATH).size;
log("generate.done", { elapsedMs: generateMs, dbBytes });

// --- 2..4. load through the real matrix, then run the scan gates ---
const profile = makeEmbeddingProfile({ model: "bench", dimensions: DIMS, task: "bench", cacheNamespace: MODEL });

interface GateReport {
  readonly receipt: Record<string, unknown>;
  readonly pass: boolean;
}

// The generator assigns HOT_PROJECT to exactly every 10th row deterministically
// (index % 10 === 0), so the hot-project row count is known analytically —
// no store query needed now that scope filtering lives in the matrix.
const HOT_PROJECT_ROWS = Math.ceil(ROWS / 10);

const report: GateReport = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const matrix = yield* VectorMatrix;
      yield* matrix.awaitLoaded;
      const status = yield* matrix.status;
      if (!status.enabled || status.rows !== ROWS) {
        throw new Error(`matrix failed to load: enabled=${status.enabled} rows=${status.rows} expected=${ROWS}`);
      }
      const rssAfterLoad = process.memoryUsage().rss;
      log("load.done", { loadMs: status.loadMs, rows: status.rows, kernel: status.kernel, workers: status.workerCount, rssAfterLoad });

      const queryRandom = makeRandom(0xfeedbeef);

      // warmup: touch every page once, settle the workers
      for (let round = 0; round < 3; round += 1) {
        yield* matrix.search({ vector: randomVector(queryRandom), limit: 10 });
      }

      const unfilteredMs: number[] = [];
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const vector = randomVector(queryRandom);
        const started = performance.now();
        const hits = yield* matrix.search({ vector, limit: 10 });
        unfilteredMs.push(performance.now() - started);
        if (hits.length !== 10) throw new Error(`unfiltered scan returned ${hits.length} hits`);
      }
      log("unfiltered.done", timingStats(unfilteredMs));

      const filteredMs: number[] = [];
      // filtered warmup: in-matrix scope filter, no SQL, no store round trip.
      for (let round = 0; round < 3; round += 1) {
        yield* matrix.search({ vector: randomVector(queryRandom), limit: 10, projectKey: HOT_PROJECT });
      }
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const vector = randomVector(queryRandom);
        const started = performance.now();
        const hits = yield* matrix.search({ vector, limit: 10, projectKey: HOT_PROJECT });
        filteredMs.push(performance.now() - started);
        if (hits.length !== 10) throw new Error(`filtered scan returned ${hits.length} hits`);
      }
      log("filtered.done", timingStats(filteredMs));

      const rssAfterQueries = process.memoryUsage().rss;
      const unfiltered = timingStats(unfilteredMs);
      const filtered = timingStats(filteredMs);
      const gates = {
        bootLoad: {
          limitMs: GATE_LOAD_MS,
          loadMs: status.loadMs ?? -1,
          rows: status.rows,
          skippedRows: status.loadSkippedRows,
          pass: (status.loadMs ?? Number.POSITIVE_INFINITY) < GATE_LOAD_MS,
        },
        rssAfterLoad: {
          limitBytes: GATE_RSS_BYTES,
          rssBytes: rssAfterLoad,
          rssAfterQueriesBytes: rssAfterQueries,
          pass: rssAfterLoad < GATE_RSS_BYTES,
        },
        unfilteredScan: {
          limitMs: GATE_SCAN_MS,
          ...unfiltered,
          pass: unfiltered.p95Ms < GATE_SCAN_MS,
        },
        filteredScan: {
          limitMs: GATE_SCAN_MS,
          candidates: HOT_PROJECT_ROWS,
          candidateFraction: Math.round((HOT_PROJECT_ROWS / ROWS) * 10_000) / 10_000,
          ...filtered,
          pass: filtered.p95Ms < GATE_SCAN_MS,
        },
      };
      const pass = gates.bootLoad.pass && gates.rssAfterLoad.pass && gates.unfilteredScan.pass && gates.filteredScan.pass;
      return {
        pass,
        receipt: {
          generatedAt: new Date().toISOString(),
          script: "scripts/matrix-kernel-bench.ts",
          machine: {
            platform: process.platform,
            arch: process.arch,
            cpuModel: cpus()[0]?.model ?? "unknown",
            cpuCount: cpus().length,
            totalMemBytes: totalmem(),
            bunVersion: Bun.version,
          },
          input: { rows: ROWS, dims: DIMS, samples: SAMPLES, model: MODEL },
          kernel: {
            package: "simsimd",
            version: simsimdVersion,
            mode: status.kernel,
            libraryPath: native.libraryPath,
            capabilities: native.capabilities,
            workerCount: status.workerCount,
          },
          generate: { elapsedMs: generateMs, dbBytes, reusedExistingDb: REUSE_DB },
          gates,
          pass,
        },
      } satisfies GateReport;
    }).pipe(
      Effect.provide(
        makeVectorMatrixLayer({ profile }).pipe(Layer.provideMerge(makeLocalStoreLayer(DB_PATH))),
      ),
    ),
  ),
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report.receipt, null, 2)}\n`);
log("receipt.written", { out: OUT, pass: report.pass });

// Only clean up the temp dir this script created; never delete around a
// caller-supplied --db path.
if (!KEEP_DB && EXPLICIT_DB === undefined && existsSync(DB_PATH)) {
  rmSync(dirname(DB_PATH), { recursive: true, force: true });
}

if (!report.pass) {
  console.error(JSON.stringify({ ok: false, error: "matrix kernel gates failed", out: OUT }));
  process.exit(1);
}
