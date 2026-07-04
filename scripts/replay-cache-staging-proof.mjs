#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";

import { makeEmbeddingProfile } from "../packages/server/src/embeddingProfiles.ts";
import { makeEmbeddingsLayer } from "../packages/server/src/embeddings.ts";
import { LanceDb } from "../packages/server/src/lancedb.ts";
import { DurableQueue, Embeddings } from "../packages/server/src/services.ts";
import { LocalStore, makeLocalStoreLayer } from "../packages/server/src/store.ts";

const command = "replay-cache-staging-proof";
const args = process.argv.slice(2);
const generatedAt = new Date().toISOString().replaceAll(":", "-");

const usage = {
  command,
  description: "Snapshot a supplied SQLite truth DB and replay cached embedding vectors into SQLite message_vectors on the copy.",
  usage: "bun scripts/replay-cache-staging-proof.mjs --source-db /path/to/quasar.sqlite [--out docs/proofs/replay-cache-staging-proof.json]",
  options: [
    "--source-db path        Required SQLite truth DB to snapshot with VACUUM INTO.",
    "--out path              Optional wrapped proof report. Defaults under docs/proofs/.",
    "--cache-namespace name  Optional embedding cache namespace. Defaults to the largest cache namespace in the snapshot.",
    "--limit n               Optional replay batch size. Defaults to max(20000, uncachedMessages + 1).",
    "--max-batches n         Optional loop cap. Defaults to 100000.",
    "--cleanup               Delete the generated temp staging directory after a successful run.",
  ],
};

const valueFlags = new Set(["--source-db", "--out", "--cache-namespace", "--limit", "--max-batches"]);
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

const optionValue = (flag, fallback) => {
  const index = args.lastIndexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`, { flag }, 2);
  return value;
};

const hasFlag = (flag) => args.includes(flag);

const positiveIntOption = (flag, fallback) => {
  const raw = optionValue(flag);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  fail(`${flag} must be a positive integer`, { flag, received: raw }, 2);
};

const quoteSqlString = (value) => `'${value.replaceAll("'", "''")}'`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

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

const workDir = mkdtempSync(join(tmpdir(), "quasar-replay-cache-staging-"));
const workDb = join(workDir, "quasar.sqlite");
const outPath = resolve(optionValue("--out", `docs/proofs/replay-cache-staging-proof-${generatedAt}.json`));
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

const snapshot = new Database(resolvedSourceDb, { readonly: true });
try {
  snapshot.exec(`VACUUM INTO ${quoteSqlString(workDb)}`);
} finally {
  snapshot.close();
}

let report;
try {
  const selectedCache = selectCacheNamespace(workDb, optionValue("--cache-namespace"));
  const expected = computeCacheReplayCoverage(workDb, selectedCache.model);
  const replayLimit = positiveIntOption("--limit", Math.max(20_000, expected.missingReplayableMessages + 1));
  const maxBatches = positiveIntOption("--max-batches", 100_000);
  const replay = await runReplay({
    workDb,
    cacheNamespace: selectedCache.model,
    dimensions: selectedCache.dimensions,
    limit: replayLimit,
    maxBatches,
    expectedReplayableMessages: expected.replayableMessagesByDocumentHash,
  });
  const gates = {
    initialSqliteVectorsZero: replay.initialCoverage.vectorRows === 0,
    upsertedReplayableMessages: replay.totals.sqliteVectorsUpserted === expected.replayableMessagesByDocumentHash,
    reachedCacheReplayCeiling: replay.finalCoverage.vectorRows >= expected.replayableMessagesByDocumentHash,
    remainingEqualsUncached: replay.finalCoverage.vectorlessMessages === expected.missingReplayableMessages,
    staleVectorRowsZero: replay.finalCoverage.staleVectorRows === 0,
    providerCallsBlocked: replay.providerCalls === 0,
  };
  const ok = Object.values(gates).every(Boolean);
  report = {
    ok,
    command,
    data: {
      sourceDb: resolvedSourceDb,
      workDir,
      workDb,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      cache: selectedCache,
      replayLimit,
      maxBatches,
      expected,
      replay,
      gates,
    },
  };
  if (!ok) {
    fail("cache replay proof did not reach the measured cache ceiling", report.data);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "cache replay proof failed", {
    error: error instanceof Error ? error.message : String(error),
    workDir,
    workDb,
  });
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
if (hasFlag("--cleanup")) {
  rmSync(workDir, { recursive: true, force: true });
}
printJson({ ...report, outPath });

function selectCacheNamespace(sqlite, requested) {
  const db = new Database(sqlite, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT model, dimensions, COUNT(*) AS rows, SUM(text_bytes) AS textBytes, MIN(created_at) AS firstCreatedAt, MAX(updated_at) AS lastUpdatedAt
         FROM embedding_cache
         GROUP BY model, dimensions
         ORDER BY rows DESC`,
      )
      .all();
    if (rows.length === 0) {
      throw new Error("embedding_cache has no rows to replay");
    }
    const matching = requested === undefined
      ? rows
      : rows.filter((row) => row.model === requested);
    if (matching.length === 0) {
      throw new Error(`embedding cache namespace not found: ${requested}`);
    }
    const selected = matching[0];
    const sameModelDimensionRows = matching.filter((row) => row.model === selected.model);
    if (sameModelDimensionRows.length > 1) {
      throw new Error(`embedding cache namespace has multiple dimensions: ${selected.model}`);
    }
    return selected;
  } finally {
    db.close();
  }
}

function computeCacheReplayCoverage(sqlite, cacheNamespace) {
  const db = new Database(sqlite, { readonly: true });
  try {
    const cacheHashes = new Set();
    for (const row of db.query("SELECT content_hash AS contentHash FROM embedding_cache WHERE model = ?").iterate(cacheNamespace)) {
      cacheHashes.add(row.contentHash);
    }
    let searchableMessages = 0;
    let replayableMessagesByDocumentHash = 0;
    let rawContentHashMatches = 0;
    for (const row of db
      .query("SELECT text, content_hash AS contentHash FROM messages WHERE role IN (?, ?, ?)")
      .iterate("user", "assistant", "reasoning")) {
      searchableMessages += 1;
      const documentHash = sha256(`search_document: ${row.text}`);
      if (cacheHashes.has(documentHash)) replayableMessagesByDocumentHash += 1;
      if (cacheHashes.has(row.contentHash)) rawContentHashMatches += 1;
    }
    return {
      cacheNamespace,
      cacheRows: cacheHashes.size,
      searchableMessages,
      replayableMessagesByDocumentHash,
      missingReplayableMessages: searchableMessages - replayableMessagesByDocumentHash,
      replayCoverage: searchableMessages === 0 ? 1 : replayableMessagesByDocumentHash / searchableMessages,
      rawContentHashMatches,
    };
  } finally {
    db.close();
  }
}

async function runReplay({ workDb, cacheNamespace, dimensions, limit, maxBatches, expectedReplayableMessages }) {
  let providerCalls = 0;
  const forbiddenEmbedder = {
    embedMany: async () => {
      providerCalls += 1;
      throw new Error("cache replay proof must not call the embedding provider");
    },
  };
  const profile = makeEmbeddingProfile({
    model: "cache-replay-proof",
    dimensions,
    task: "search_document",
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
    cacheNamespace,
  });
  const unused = (name) => Effect.fail(new Error(`${name} is not available in cache replay proof`));
  const queueLayer = Layer.succeed(DurableQueue, DurableQueue.of({
    enqueue: () => unused("DurableQueue.enqueue"),
    leaseBatch: () => unused("DurableQueue.leaseBatch"),
    ack: () => unused("DurableQueue.ack"),
    retry: () => unused("DurableQueue.retry"),
    fail: () => unused("DurableQueue.fail"),
    recoverStaleLeases: () => unused("DurableQueue.recoverStaleLeases"),
    pruneCompleted: () => unused("DurableQueue.pruneCompleted"),
    stats: unused("DurableQueue.stats"),
    statsByKind: unused("DurableQueue.statsByKind"),
    embedMessageStatsByProfile: () => unused("DurableQueue.embedMessageStatsByProfile"),
  }));
  const lanceLayer = Layer.succeed(LanceDb, LanceDb.make({
    dataDir: "cache-replay-proof-unused",
    connect: unused("LanceDb.connect"),
    openTable: () => unused("LanceDb.openTable"),
    ensureMessageTable: () => unused("LanceDb.ensureMessageTable"),
    createMessageIndexes: () => unused("LanceDb.createMessageIndexes"),
    countRows: () => unused("LanceDb.countRows"),
    tableIndexStats: () => unused("LanceDb.tableIndexStats"),
    optimize: () => unused("LanceDb.optimize"),
    tableStats: () => unused("LanceDb.tableStats"),
    ensureTable: () => unused("LanceDb.ensureTable"),
    upsertMessageRows: () => unused("LanceDb.upsertMessageRows"),
    upsertRows: () => unused("LanceDb.upsertRows"),
    deleteByKeys: () => unused("LanceDb.deleteByKeys"),
    readRows: () => unused("LanceDb.readRows"),
    readMessageRowsBySession: () => unused("LanceDb.readMessageRowsBySession"),
    readMessageRowsBySessions: () => unused("LanceDb.readMessageRowsBySessions"),
    vectorSearch: () => unused("LanceDb.vectorSearch"),
    ftsSearch: () => unused("LanceDb.ftsSearch"),
    hybridSearch: () => unused("LanceDb.hybridSearch"),
    listIndexDirNames: () => unused("LanceDb.listIndexDirNames"),
    deleteIndexDirsByName: () => unused("LanceDb.deleteIndexDirsByName"),
    gcSupersededIndexDirs: () => unused("LanceDb.gcSupersededIndexDirs"),
  }));

  const dependencyLayer = Layer.mergeAll(
    makeLocalStoreLayer(workDb),
    queueLayer,
    lanceLayer,
  );
  const layer = makeEmbeddingsLayer({ sqlite: workDb, profile, embedder: forbiddenEmbedder }).pipe(
    Layer.provideMerge(dependencyLayer),
  );

  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const embeddings = yield* Embeddings;
        const store = yield* LocalStore;
        const initialCoverage = yield* store.messageVectorCoverage(cacheNamespace);
        const totals = {
          scanned: 0,
          cacheHits: 0,
          missingCache: 0,
          sqliteVectorsUpserted: 0,
        };
        const batches = [];
        let finalCoverage = initialCoverage;
        for (let batch = 0; batch < maxBatches && finalCoverage.vectorRows < expectedReplayableMessages; batch += 1) {
          const report = yield* embeddings.materializeCachedVectors({ limit });
          finalCoverage = yield* store.messageVectorCoverage(cacheNamespace);
          totals.scanned += report.scanned;
          totals.cacheHits += report.cacheHits;
          totals.missingCache += report.missingCache;
          totals.sqliteVectorsUpserted += report.sqliteVectorsUpserted;
          batches.push({ batch: batch + 1, report, coverage: finalCoverage });
          if (report.scanned === 0 || report.cacheHits === 0 || report.sqliteVectorsUpserted === 0) break;
        }
        return {
          initialCoverage,
          finalCoverage,
          batchCount: batches.length,
          totals,
          lastBatch: batches.at(-1),
          providerCalls,
        };
      }).pipe(Effect.provide(layer)),
    ),
  );
}

function pathIsInside(child, parent) {
  const childRelativeToParent = relative(parent, child);
  return childRelativeToParent === "" || (!childRelativeToParent.startsWith("..") && !isAbsolute(childRelativeToParent));
}
