import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { EmbeddingProfile } from "../src/embeddingProfiles";
import { fts5QueryForText } from "../src/fts5";
import {
  documentCacheKey,
  inspectEmbeddingCoverage,
  measureEmbeddingParity,
  runSqliteFirstProof,
} from "../src/sqliteFirstProof";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-sqlite-first-proof-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const profile: EmbeddingProfile = {
  model: "test-model",
  dimensions: 3,
  task: "search_document",
  cacheNamespace: "test-profile",
  documentPrefix: "search_document: ",
  queryPrefix: "search_query: ",
};

const makeFixtureDb = (path: string) => {
  const db = new Database(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE messages (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      ts TEXT,
      project_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE embedding_cache (
      model TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      text_bytes INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (model, content_hash)
    );
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages(session_id, seq, role, text, ts, project_key, content_hash)
    VALUES ($sessionId, $seq, $role, $text, NULL, $projectKey, $contentHash)
  `);
  insertMessage.run({
    $sessionId: "s1",
    $seq: 1,
    $role: "user",
    $text: "alpha sqlite search proof",
    $projectKey: "project-a",
    $contentHash: "raw-a",
  });
  insertMessage.run({
    $sessionId: "s1",
    $seq: 2,
    $role: "assistant",
    $text: "beta vector cache proof",
    $projectKey: "project-a",
    $contentHash: "raw-b",
  });
  insertMessage.run({
    $sessionId: "s1",
    $seq: 3,
    $role: "assistant",
    $text: "missing vector row",
    $projectKey: "project-a",
    $contentHash: "raw-c",
  });
  const insertCache = db.prepare(`
    INSERT INTO embedding_cache(model, content_hash, dimensions, text_bytes, vector_json, created_at, updated_at)
    VALUES ($model, $contentHash, $dimensions, $textBytes, $vectorJson, '2026-07-04T00:00:00.000Z', '2026-07-04T00:00:00.000Z')
  `);
  insertCache.run({
    $model: profile.cacheNamespace,
    $contentHash: documentCacheKey("alpha sqlite search proof", profile),
    $dimensions: 3,
    $textBytes: 25,
    $vectorJson: JSON.stringify([1, 0, 0]),
  });
  insertCache.run({
    $model: profile.cacheNamespace,
    $contentHash: documentCacheKey("beta vector cache proof", profile),
    $dimensions: 3,
    $textBytes: 23,
    $vectorJson: JSON.stringify([0, 1, 0]),
  });
  db.close();
};

describe("sqlite-first proof helpers", () => {
  test("uses the prefixed document cache key used by the embed worker", () => {
    expect(documentCacheKey("hello", profile)).toBe(documentCacheKey("hello", profile));
    expect(documentCacheKey("hello", profile)).not.toBe(documentCacheKey("search_document: hello", profile));
  });

  test("builds hostile-input-safe FTS5 query strings", () => {
    expect(fts5QueryForText("sqlite: proof - vector")).toBe('"sqlite" AND "proof" AND "vector"');
    expect(fts5QueryForText(" ::: ")).toBeUndefined();
  });

  test("reports cache coverage against distinct document hashes", () => {
    const dir = tempDir();
    const path = join(dir, "source.sqlite");
    makeFixtureDb(path);
    const db = new Database(path, { readonly: true });
    try {
      const coverage = inspectEmbeddingCoverage(db, profile);
      expect(coverage.semanticRows).toBe(3);
      expect(coverage.distinctDocumentHashes).toBe(3);
      expect(coverage.cachedDocumentHashes).toBe(2);
      expect(coverage.missingDocumentHashes).toBe(1);
      expect(coverage.missingExamples).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("runs the proof on an isolated work database", () => {
    const dir = tempDir();
    const sourceDb = join(dir, "source.sqlite");
    const workDb = join(dir, "work.sqlite");
    makeFixtureDb(sourceDb);

    const report = runSqliteFirstProof({
      sourceDb,
      workDb,
      profile,
      queries: ["sqlite proof", "vector cache"],
      ftsBenchmarkSamples: 3,
      ftsFilterProjectKey: "project-a",
      ftsFilterRole: "assistant",
      vectorLimit: 10,
      exactScanLimit: 10,
      exactScanSamples: 3,
      exactScanKernel: "usearch",
      exactScanThreads: 1,
    });

    expect(report.embeddingCoverage.cachedDocumentHashes).toBe(2);
    expect(report.fts.rowsIndexed).toBe(3);
    expect(report.fts.queryTimings.every((timing) => timing.hits > 0)).toBe(true);
    expect(report.fts.filteredBenchmarks).toHaveLength(2);
    expect(report.fts.filteredBenchmarks.every((benchmark) => benchmark.samples === 3)).toBe(true);
    expect(report.fts.filteredBenchmarks.every((benchmark) => benchmark.filters.projectKey === "project-a")).toBe(true);
    expect(report.fts.filteredBenchmarks.every((benchmark) => benchmark.filters.role === "assistant")).toBe(true);
    expect(report.fts.filteredBenchmarks.find((benchmark) => benchmark.query === "vector cache")?.hits).toBe(1);
    expect(report.vectors.rowsScanned).toBe(3);
    expect(report.vectors.rowsInserted).toBe(2);
    expect(report.vectors.rowsMissingCache).toBe(1);
    expect(report.exactScan.queryAnchor).toEqual({ sessionId: "s1", seq: 1 });
    expect(report.exactScan.implementation).toBe("usearch-exact-cosine");
    expect(report.exactScan.kernel).toMatchObject({
      package: "usearch",
      version: "2.25.3",
      metric: "cosine-similarity",
      threads: 1,
    });
    expect(report.exactScan.samples).toBe(3);
    expect(report.exactScan.rowsScanned).toBe(1);
    expect(report.exactScan.best).toEqual({ sessionId: "s1", seq: 2, score: 0 });

    const source = new Database(sourceDb, { readonly: true });
    try {
      expect(() => source.query("SELECT COUNT(*) FROM proof_messages_fts").get()).toThrow();
    } finally {
      source.close();
    }
  });

  test("measures local-vs-cached embedding parity with an explicit cosine threshold", async () => {
    const dir = tempDir();
    const path = join(dir, "source.sqlite");
    makeFixtureDb(path);
    const db = new Database(path, { readonly: true });
    try {
      const report = await measureEmbeddingParity(
        db,
        profile,
        profile,
        {
          embedMany: async (values) =>
            values.map((value) => {
              if (value.includes("alpha")) return [1, 0, 0];
              if (value.includes("beta")) return [0, 1, 0];
              return [0, 0, 1];
            }),
        },
        { sampleSize: 2, threshold: 0.999 },
      );

      expect(report.eligibleCachedMessages).toBe(2);
      expect(report.sampleSize).toBe(2);
      expect(report.threshold).toBe(0.999);
      expect(report.passed).toBe(true);
      expect(report.scores.min).toBe(1);
      expect(report.belowThreshold).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
