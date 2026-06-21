import { afterEach, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer, makeLanceDbRuntime } from "../src/lancedb";
import {
  GEMINI_EMBEDDING_DIMENSIONS,
  MESSAGE_SEARCH_COLUMNS,
} from "../src/lancedb";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "quasar-lancedb-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LanceDb", () => {
  test("opens a temp LanceDB directory, writes one row, and reads it back", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));

    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertRows({
          rows: [{ key: "session:1:0", text: "alpha terminal response", vector: [0.1, 0.2, 0.3] }],
          vectorDimension: 3,
        });
        return yield* search.readRows({ limit: 1, select: ["key", "text"] });
      }),
    );

    expect(rows).toEqual([{ key: "session:1:0", text: "alpha terminal response" }]);
  });

  test("exports a ManagedRuntime helper for action entrypoints", async () => {
    const dataDir = await makeTempDir();
    const runtime = makeLanceDbRuntime({ dataDir });

    const serviceDataDir = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        return search.dataDir;
      }),
    );

    expect(serviceDataDir).toBe(dataDir);
  });

  test("bootstraps the message table schema, FTS index, vector index, and hybrid ranking", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const alphaVector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const betaVector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 1 ? 1 : 0,
    );
    const gammaVector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 2 ? 1 : 0,
    );

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.ensureMessageTable({
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "alpha terminal response",
              contentHash: "hash-a",
              vector: alphaVector,
            },
            {
              sessionId: "session-b",
              seq: 1,
              role: "assistant",
              projectKey: "project-a",
              text: "terminal response lexical only",
              contentHash: "hash-b",
              vector: betaVector,
            },
            {
              sessionId: "session-c",
              seq: 1,
              role: "assistant",
              projectKey: "project-a",
              text: "semantic only",
              contentHash: "hash-c",
              vector: alphaVector,
            },
            {
              sessionId: "session-d",
              seq: 1,
              role: "assistant",
              projectKey: "project-a",
              text: "unrelated note",
              contentHash: "hash-d",
              vector: gammaVector,
            },
          ],
          createIndexes: true,
          includeVectorIndex: false,
        });
        yield* search.createMessageIndexes({ minVectorRows: 1 });
        const table = yield* search.openTable({});
        const indexNames = yield* Effect.tryPromise({
          try: async () => (await table.listIndices()).map((index) => index.name).sort(),
          catch: (cause) => cause,
        });
        const hits = yield* search.hybridSearch({
          query: "terminal response",
          vector: alphaVector,
          vectorDimension: GEMINI_EMBEDDING_DIMENSIONS,
          limit: 4,
          select: MESSAGE_SEARCH_COLUMNS,
        });
        return { indexNames, hits };
      }),
    );

    expect(result.indexNames).toEqual(["text_idx", "vector_idx"]);
    expect(result.hits.map((hit) => hit.key)).toContain("session-b:1:assistant");
    expect(result.hits.map((hit) => hit.key)).toContain("session-c:1:assistant");
    expect(result.hits[0]?.key).toBe("session-a:1:user");
    expect(result.hits[0]?.row.text).toBe("alpha terminal response");
  });

  test("enforces Gemini embedding dimensions for message writes", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));

    await expect(
      runtime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          yield* search.upsertMessageRows({
            rows: [
              {
                sessionId: "session-a",
                seq: 1,
                role: "user",
                projectKey: "project-a",
                text: "too short",
                contentHash: "hash",
                vector: [0.1, 0.2, 0.3],
              },
            ],
          });
        }),
      ),
    ).rejects.toThrow("vector has dimension 3; expected 1536");
  });

  test("can create a lexical-only message index without training a vector index", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, () => 0);

    const indexNames = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.ensureMessageTable({
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "lexical fallback row",
              contentHash: "unembedded:hash-a",
              vector,
            },
          ],
          createIndexes: true,
          includeVectorIndex: false,
        });
        const table = yield* search.openTable({});
        return yield* Effect.tryPromise({
          try: async () => (await table.listIndices()).map((index) => index.name).sort(),
          catch: (cause) => cause,
        });
      }),
    );

    expect(indexNames).toEqual(["text_idx"]);
  });

  test("semantic search can filter out lexical-only placeholder vectors", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const zeroVector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, () => 0);
    const readyVector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const hits = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.ensureMessageTable({
          rows: [
            {
              sessionId: "session-placeholder",
              seq: 1,
              role: "assistant",
              projectKey: "project-a",
              text: "lexical-only placeholder",
              contentHash: "unembedded:hash-placeholder",
              vector: zeroVector,
            },
            {
              sessionId: "session-ready",
              seq: 1,
              role: "assistant",
              projectKey: "project-a",
              text: "semantic-ready row",
              contentHash: "hash-ready",
              vector: readyVector,
            },
          ],
          createIndexes: false,
        });
        return yield* search.vectorSearch({
          vector: readyVector,
          vectorDimension: GEMINI_EMBEDDING_DIMENSIONS,
          limit: 10,
          filter: "contentHash NOT LIKE 'unembedded:%'",
          select: ["key", "contentHash"],
        });
      }),
    );

    expect(hits.map((hit) => hit.key)).toEqual(["session-ready:1:assistant"]);
  });

  test("derives message identity from sessionId, seq, and role", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.ensureMessageTable({ createIndexes: false });
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "first text",
              contentHash: "hash-a",
              vector,
            },
          ],
        });
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "updated text",
              contentHash: "hash-b",
              vector,
            },
          ],
        });
        return yield* search.readRows({
          limit: 5,
          select: ["key", "sessionId", "seq", "role", "text", "contentHash"],
        });
      }),
    );

    expect(rows).toEqual([
      {
        key: "session-a:1:user",
        sessionId: "session-a",
        seq: 1,
        role: "user",
        text: "updated text",
        contentHash: "hash-b",
      },
    ]);
  });

  test("lists current message rows by sessionId and deletes returned keys", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.ensureMessageTable({ createIndexes: false });
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "session-a",
              seq: 2,
              role: "assistant",
              projectKey: "project-a",
              text: "second text",
              contentHash: "hash-a2",
              vector,
            },
            {
              sessionId: "session-b",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "other session",
              contentHash: "hash-b1",
              vector,
            },
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "first text",
              contentHash: "hash-a1",
              vector,
            },
          ],
        });

        const listed = yield* search.readMessageRowsBySession({
          sessionId: "session-a",
          select: ["key", "sessionId", "seq", "role", "text"],
        });
        const deleted = yield* search.deleteByKeys({ keys: ["session-a:1:user"] });
        const remaining = yield* search.readMessageRowsBySession({
          sessionId: "session-a",
          select: ["key", "sessionId", "seq", "role", "text"],
        });

        return { listed, deleted, remaining };
      }),
    );

    expect([...result.listed].sort((left, right) => String(left.key).localeCompare(String(right.key)))).toEqual([
      {
        key: "session-a:1:user",
        sessionId: "session-a",
        seq: 1,
        role: "user",
        text: "first text",
      },
      {
        key: "session-a:2:assistant",
        sessionId: "session-a",
        seq: 2,
        role: "assistant",
        text: "second text",
      },
    ]);
    expect(result.deleted).toBe(1);
    expect(result.remaining).toEqual([
      {
        key: "session-a:2:assistant",
        sessionId: "session-a",
        seq: 2,
        role: "assistant",
        text: "second text",
      },
    ]);
  });

  test("createMessageIndexes is idempotent and skips existing indexes", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const firstStats = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "first text",
              contentHash: "hash-a",
              vector,
            },
          ],
        });
        yield* search.createMessageIndexes({ minVectorRows: 1 });
        return yield* search.tableStats({});
      }),
    );

    const secondStats = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.createMessageIndexes({ minVectorRows: 1 });
        return yield* search.tableStats({});
      }),
    );

    expect(firstStats.indices.map((index) => index.name).sort()).toEqual(["text_idx", "vector_idx"]);
    expect(secondStats.indices.map((index) => index.name).sort()).toEqual(["text_idx", "vector_idx"]);
    expect(secondStats.disk.totalBytes).toBe(firstStats.disk.totalBytes);
  });

  test("upsertMessageRows bootstraps the table without creating indexes", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const stats = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "first text",
              contentHash: "hash-a",
              vector,
            },
          ],
        });
        return yield* search.tableStats({});
      }),
    );

    expect(stats.rowCount).toBe(1);
    expect(stats.indices).toEqual([]);
    expect(stats.disk.indexBytes).toBe(0);
  });

  test("tableStats reports row count, indices, and disk sizes", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const stats = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "first text",
              contentHash: "hash-a",
              vector,
            },
          ],
        });
        yield* search.createMessageIndexes({ minVectorRows: 1 });
        return yield* search.tableStats({});
      }),
    );

    expect(stats.rowCount).toBe(1);
    expect(stats.indices.map((index) => index.name).sort()).toEqual(["text_idx", "vector_idx"]);
    expect(stats.indices[0]?.numIndexedRows).toBe(1);
    expect(stats.disk.totalBytes).toBeGreaterThan(0);
    expect(stats.disk.dataBytes).toBeGreaterThanOrEqual(0);
    expect(stats.disk.indexBytes).toBeGreaterThanOrEqual(0);
    expect(stats.disk.versionBytes).toBeGreaterThanOrEqual(0);
    expect(stats.tableStats.numRows).toBe(1);
  });

  test("optimizeTable compacts and reports prune stats", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const report = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              text: "first text",
              contentHash: "hash-a",
              vector,
            },
          ],
        });
        yield* search.createMessageIndexes();
        return yield* search.optimizeTable({ cleanupOlderThan: new Date() });
      }),
    );

    expect(report.tableName).toBe("messages");
    expect(report.stats.compaction).toBeDefined();
    expect(report.stats.prune).toBeDefined();
  });
});
