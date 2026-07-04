#!/usr/bin/env bun
// Serving-path bench for query-side embedText() latency (D8b fp32 pin).
//
// Drives the REAL production Embeddings layer (makeEmbeddingsLayer, no
// injected embedder) so pipeline construction, cache-dir resolution, and the
// eager background load are exactly what a running server does — not a
// one-off host-process script. Each sample embeds a DISTINCT query text:
// embedText caches by contentHash, so re-embedding the same string after the
// first call would just read the cache and measure nothing about the ONNX
// pipeline.
//
// Gate thresholds are set with headroom over the grounding receipt
// (docs/proofs/query-embed-parity-fp32-2026-07-04.json: fp32 p50 31.5ms on
// this machine class) to absorb ordinary CPU contention on a shared dev box
// while still catching a real regression (wrong dtype, broken cache,
// accidental fallback to the bounded synthetic path).
//
// Usage: bun scripts/query-embed-bench.ts [--samples N] [--out path]
//
// Point QUASAR_EMBEDDING_MODEL_CACHE_DIR at a directory that already holds
// the fp32 model (see scripts/bake-onnx-model.ts) unless this run should pay
// for the ~530MB download itself.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { Effect, Layer } from "effect";

import { embeddingProfileFromEnv } from "../packages/server/src/embeddingProfiles";
import { makeEmbeddingsLayer, QUERY_EMBEDDING_ONNX_DTYPE } from "../packages/server/src/embeddings";
import { Embeddings, makeDurableQueueLayer } from "../packages/server/src/services";
import { makeLocalStoreLayer } from "../packages/server/src/store";

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

const SAMPLES = intArg("--samples", 20);
const OUT = resolve(repoRoot, argValue("--out") ?? "docs/proofs/query-embed-bench-2026-07-04.json");

const GATE_LOAD_MS = 120_000;
const GATE_P50_MS = 150;
const GATE_P95_MS = 300;

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event: `query_embed_bench.${event}`, at: new Date().toISOString(), ...fields }));

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
    p50Ms: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
};

const dbDir = mkdtempSync(join(tmpdir(), "quasar-query-embed-bench-"));
const dbPath = join(dbDir, "bench.sqlite");
const profile = embeddingProfileFromEnv();
const dataLayer = makeLocalStoreLayer(dbPath);
const queueLayer = makeDurableQueueLayer(dbPath);
const embeddingsLayer = makeEmbeddingsLayer({ sqlite: dbPath, profile }).pipe(
  Layer.provide(Layer.merge(dataLayer, queueLayer)),
);

interface GateReport {
  readonly receipt: Record<string, unknown>;
  readonly pass: boolean;
}

const report: GateReport = await Effect.runPromise(
  Effect.gen(function* () {
    const embeddings = yield* Embeddings;
    const loadStarted = performance.now();
    let status = yield* embeddings.status;
    const deadline = Date.now() + GATE_LOAD_MS;
    while (
      status.queryEmbedder.active !== "local"
      && status.queryEmbedder.loadFailure === undefined
      && Date.now() < deadline
    ) {
      yield* Effect.sleep("50 millis");
      status = yield* embeddings.status;
    }
    const loadMs = Math.round(performance.now() - loadStarted);
    if (status.queryEmbedder.active !== "local") {
      throw new Error(`local query pipeline did not activate within ${GATE_LOAD_MS}ms: ${JSON.stringify(status.queryEmbedder)}`);
    }
    log("load.done", { loadMs, dtype: QUERY_EMBEDDING_ONNX_DTYPE, model: profile.model });

    // Warmup outside the timed samples: first-call JIT/allocator overhead.
    yield* embeddings.embedText("quasar query embed bench warmup");

    const samplesMs: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const text = `quasar query embed bench sample ${index} ${Math.random()}`;
      const started = performance.now();
      yield* embeddings.embedText(text);
      samplesMs.push(performance.now() - started);
    }
    const stats = timingStats(samplesMs);
    log("samples.done", stats);

    const gates = {
      pipelineLoad: { limitMs: GATE_LOAD_MS, loadMs, pass: loadMs < GATE_LOAD_MS },
      embedLatency: {
        limitP50Ms: GATE_P50_MS,
        limitP95Ms: GATE_P95_MS,
        ...stats,
        pass: stats.p50Ms < GATE_P50_MS && stats.p95Ms < GATE_P95_MS,
      },
    };
    const pass = gates.pipelineLoad.pass && gates.embedLatency.pass;
    return {
      pass,
      receipt: {
        generatedAt: new Date().toISOString(),
        script: "scripts/query-embed-bench.ts",
        model: profile.model,
        dimensions: profile.dimensions,
        dtype: QUERY_EMBEDDING_ONNX_DTYPE,
        cacheDir: process.env.QUASAR_EMBEDDING_MODEL_CACHE_DIR?.trim() || null,
        gates,
        pass,
      },
    } satisfies GateReport;
  }).pipe(Effect.provide(Layer.mergeAll(dataLayer, queueLayer, embeddingsLayer))),
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report.receipt, null, 2)}\n`);
log("receipt.written", { out: OUT, pass: report.pass });
rmSync(dbDir, { recursive: true, force: true });

if (!report.pass) {
  console.error(JSON.stringify({ ok: false, error: "query embed bench gates failed", out: OUT }));
  process.exit(1);
}
