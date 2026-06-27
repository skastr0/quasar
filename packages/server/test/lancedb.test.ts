import { afterEach, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer, makeLanceDbRuntime } from "../src/lancedb";
import {
  DEFAULT_MESSAGE_VECTOR_DIMENSIONS,
  MESSAGE_SEARCH_COLUMNS,
} from "../src/lancedb";

const tempDirs: string[] = [];
const LEXICAL_INDEX_NAMES = [
  "contentHash_idx",
  "projectKey_idx",
  "provider_idx",
  "role_idx",
  "sessionId_idx",
  "text_idx",
] as const;
const SEARCH_INDEX_NAMES = [...LEXICAL_INDEX_NAMES, "vector_idx"] as const;

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
    const alphaVector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const betaVector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
      index === 1 ? 1 : 0,
    );
    const gammaVector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
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
              provider: "codex",
              text: "alpha terminal response",
              contentHash: "hash-a",
              vector: alphaVector,
            },
            {
              sessionId: "session-b",
              seq: 1,
              role: "assistant",
              projectKey: "project-a",
              provider: "codex",
              text: "terminal response lexical only",
              contentHash: "hash-b",
              vector: betaVector,
            },
            {
              sessionId: "session-c",
              seq: 1,
              role: "assistant",
              projectKey: "project-a",
              provider: "codex",
              text: "semantic only",
              contentHash: "hash-c",
              vector: alphaVector,
            },
            {
              sessionId: "session-d",
              seq: 1,
              role: "assistant",
              projectKey: "project-a",
              provider: "codex",
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
          vectorDimension: DEFAULT_MESSAGE_VECTOR_DIMENSIONS,
          limit: 4,
          select: MESSAGE_SEARCH_COLUMNS,
        });
        return { indexNames, hits };
      }),
    );

    expect([...result.indexNames].sort()).toEqual([...SEARCH_INDEX_NAMES]);
    expect(result.hits.map((hit) => hit.key)).toContain("session-b:1:assistant");
    expect(result.hits.map((hit) => hit.key)).toContain("session-c:1:assistant");
    expect(result.hits[0]?.key).toBe("session-a:1:user");
    expect(result.hits[0]?.row.text).toBe("alpha terminal response");
  });

  test("enforces message vector dimensions for message writes", async () => {
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
                provider: "codex",
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
    const vector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, () => 0);

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
              provider: "codex",
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

    expect([...indexNames].sort()).toEqual([...LEXICAL_INDEX_NAMES]);
  });

  test("optimize folds new rows into the live indexes without dropping them", async () => {
    // Canonical maintenance: build once, then optimize() folds appended rows into the
    // LIVE indexes — never dropping them, so there is no absent/brute-force window. The
    // index set is identical before and after optimize (present throughout) and the
    // unindexed tail is folded in (searchable, numUnindexedRows -> 0).
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            { sessionId: "session-a", seq: 1, role: "user", projectKey: "project-a", provider: "codex", text: "needle before optimize", contentHash: "hash-a", vector },
          ],
        });
        yield* search.createMessageIndexes({ includeVector: false });
        const indicesBefore = (yield* search.tableIndexStats({})).map((index) => index.name).sort();
        // Append a row AFTER indexing, then optimize to fold it in — no drop.
        yield* search.upsertMessageRows({
          rows: [
            { sessionId: "session-b", seq: 1, role: "user", projectKey: "project-a", provider: "codex", text: "needle after optimize", contentHash: "hash-b", vector },
          ],
        });
        const optimize = yield* search.optimize({});
        const indicesAfter = (yield* search.tableIndexStats({})).map((index) => index.name).sort();
        const hits = yield* search.ftsSearch({ query: "needle", limit: 5 });
        const indexStats = yield* search.tableIndexStats({});
        return {
          indicesBefore,
          indicesAfter,
          hitKeys: hits.map((hit) => hit.key).sort(),
          unindexed: indexStats.map((index) => index.numUnindexedRows ?? 0),
          optimize,
        };
      }),
    );

    // Index set identical before/after optimize — never dropped.
    expect(result.indicesBefore).toEqual([...LEXICAL_INDEX_NAMES]);
    expect(result.indicesAfter).toEqual(result.indicesBefore);
    // optimize folded the appended row into the live index (no unindexed tail left).
    expect(result.unindexed.every((n) => n === 0)).toBe(true);
    // Both the pre-index and post-index rows are searchable.
    expect(result.hitKeys).toContain("session-a:1:user");
    expect(result.hitKeys).toContain("session-b:1:user");
    expect(result.optimize.prune.oldVersionsRemoved).toBeGreaterThanOrEqual(0);
  });

  test("semantic search can filter out lexical-only placeholder vectors", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const zeroVector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, () => 0);
    const readyVector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
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
              provider: "codex",
              text: "lexical-only placeholder",
              contentHash: "unembedded:hash-placeholder",
              vector: zeroVector,
            },
            {
              sessionId: "session-ready",
              seq: 1,
              role: "assistant",
              projectKey: "project-a",
              provider: "codex",
              text: "semantic-ready row",
              contentHash: "hash-ready",
              vector: readyVector,
            },
          ],
          createIndexes: false,
        });
        return yield* search.vectorSearch({
          vector: readyVector,
          vectorDimension: DEFAULT_MESSAGE_VECTOR_DIMENSIONS,
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
    const vector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
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
              provider: "codex",
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
              provider: "codex",
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
    const vector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
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
              provider: "codex",
              text: "second text",
              contentHash: "hash-a2",
              vector,
            },
            {
              sessionId: "session-b",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              provider: "codex",
              text: "other session",
              contentHash: "hash-b1",
              vector,
            },
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              provider: "codex",
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
    const vector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
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
              provider: "codex",
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

    expect(firstStats.indices.map((index) => index.name).sort()).toEqual([...SEARCH_INDEX_NAMES]);
    expect(secondStats.indices.map((index) => index.name).sort()).toEqual([...SEARCH_INDEX_NAMES]);
    expect(secondStats.disk.totalBytes).toBe(firstStats.disk.totalBytes);
  });

  test("upsertMessageRows bootstraps the table without creating indexes", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
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
              provider: "codex",
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
    const vector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
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
              provider: "codex",
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
    expect(stats.indices.map((index) => index.name).sort()).toEqual([...SEARCH_INDEX_NAMES]);
    expect(stats.indices[0]?.numIndexedRows).toBe(1);
    expect(stats.disk.totalBytes).toBeGreaterThan(0);
    expect(stats.disk.dataBytes).toBeGreaterThanOrEqual(0);
    expect(stats.disk.indexBytes).toBeGreaterThanOrEqual(0);
    expect(stats.disk.versionBytes).toBeGreaterThanOrEqual(0);
    expect(stats.tableStats.numRows).toBe(1);
  });

  test("createMessageIndexes never drops a present index (idempotent, no absent window)", async () => {
    // The make-impossible invariant: repeated maintenance ticks must never tear down a
    // serving index. After the first build, every subsequent createMessageIndexes is a
    // cheap no-op that leaves text_idx + vector_idx CONTINUOUSLY present — there is no
    // moment where the table falls back to a brute-force scan (the 22s outage).
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const vector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const presence = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            { sessionId: "session-a", seq: 1, role: "user", projectKey: "project-a", provider: "codex", text: "first text", contentHash: "hash-a", vector },
          ],
        });
        const seen: boolean[] = [];
        for (let cycle = 0; cycle < 5; cycle += 1) {
          yield* search.createMessageIndexes({ minVectorRows: 1 });
          const names = new Set((yield* search.tableIndexStats({})).map((index) => index.name));
          seen.push(names.has("vector_idx") && names.has("text_idx"));
        }
        const final = (yield* search.tableIndexStats({})).map((index) => index.name).sort();
        return { seen, final };
      }),
    );

    // vector_idx + text_idx present after EVERY cycle — never absent.
    expect(presence.seen).toEqual([true, true, true, true, true]);
    expect(presence.final).toEqual([...SEARCH_INDEX_NAMES]);
  });

  test("rows added after indexing stay searchable before the next rebuild (no ingested-but-invisible)", async () => {
    // Product invariant: an ingested row must be findable immediately, even before
    // the index folds it in. Seed + index, then append a NEW row with NO rebuild,
    // and require both lexical (FTS tail scan) and semantic (vector) to return it.
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const seedVector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
    const tailVector = Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, i) => (i === 7 ? 1 : 0));

    const found = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            { sessionId: "seed", seq: 0, role: "user", projectKey: "p", provider: "codex", text: "seed document", contentHash: "h-seed", vector: seedVector },
          ],
        });
        yield* search.createMessageIndexes();
        // Tail row appended AFTER indexing, with NO optimize/reindex.
        yield* search.upsertMessageRows({
          rows: [
            { sessionId: "tail", seq: 0, role: "user", projectKey: "p", provider: "codex", text: "tail needle unindexed", contentHash: "h-tail", vector: tailVector },
          ],
        });
        const lex = yield* search.ftsSearch({ query: "needle", limit: 5 }).pipe(Effect.catchAll(() => Effect.succeed([])));
        const vec = yield* search.vectorSearch({ vector: tailVector, vectorDimension: DEFAULT_MESSAGE_VECTOR_DIMENSIONS, limit: 5 }).pipe(Effect.catchAll(() => Effect.succeed([])));
        return { lexKeys: lex.map((hit) => hit.key), vecKeys: vec.map((hit) => hit.key) };
      }),
    );

    expect(found.lexKeys).toContain("tail:0:user");
    expect(found.vecKeys).toContain("tail:0:user");
  });

  test("populated vector table stays indexed + serving through append + optimize; 3 search modes, zero loss", async () => {
    // Ground-truth on real lance 0.30.0: a table carrying FTS + BTree + a real vector
    // index keeps ALL indexes present through the maintenance cycle (ensure + optimize)
    // — never an absent window — folds appended rows in, keeps lexical/semantic/fusion
    // all returning the right row, loses zero rows, and leaves vector data intact.
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    const dim = DEFAULT_MESSAGE_VECTOR_DIMENSIONS;
    const vecFor = (i: number) => Array.from({ length: dim }, (_, d) => (d === i % dim ? 1 : 0));
    const rows = Array.from({ length: 150 }, (_, i) => ({
      sessionId: `s${i % 5}`,
      seq: i,
      role: "user" as const,
      projectKey: "p",
      provider: "codex",
      text: `document ${i} needle${i}`,
      contentHash: `h${i}`,
      vector: vecFor(i),
    }));

    const r = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({ rows, vectorDimension: dim });
        yield* search.createMessageIndexes({ includeVector: true });
        const indicesAfterBuild = (yield* search.tableIndexStats({})).map((index) => index.name).sort();
        // Append 5 rows AFTER indexing, then run the SAME two maintenance steps
        // (ensure-missing, then optimize). Neither drops the live vector index.
        yield* search.upsertMessageRows({
          rows: Array.from({ length: 5 }, (_, c) => ({ sessionId: "s0", seq: 200 + c, role: "user" as const, projectKey: "p", provider: "codex", text: `churn ${c}`, contentHash: `c${c}`, vector: vecFor(c) })),
          vectorDimension: dim,
        });
        yield* search.createMessageIndexes({ includeVector: true });
        const indicesAfterEnsure = (yield* search.tableIndexStats({})).map((index) => index.name).sort();
        yield* search.optimize({});
        const indicesAfterOptimize = (yield* search.tableIndexStats({})).map((index) => index.name).sort();
        const lex = yield* search.ftsSearch({ query: "needle42", limit: 5 });
        const vec = yield* search.vectorSearch({ vector: vecFor(42), vectorDimension: dim, limit: 5 });
        const hyb = yield* search.hybridSearch({ query: "needle42", vector: vecFor(42), limit: 5 });
        const rowCount = (yield* search.readRows({ limit: 100_000, select: ["key"] })).length;
        const stored = (yield* search.readMessageRowsBySession({ sessionId: "s2", limit: 100_000, select: ["key", "vector"] })).find((x) => x.key === "s2:42:user");
        return {
          indicesAfterBuild,
          indicesAfterEnsure,
          indicesAfterOptimize,
          lex: lex.map((hit) => hit.key),
          vec: vec.map((hit) => hit.key),
          hyb: hyb.length,
          rowCount,
          // lance returns the vector as an Arrow Vector (not a typed/plain array) —
          // materialize with Array.from. Value intact at 42 == nothing clobbered it.
          vectorOk:
            stored?.vector != null &&
            (stored.vector as { length: number }).length === dim &&
            Array.from(stored.vector as Iterable<number>)[42] === 1,
        };
      }),
    );

    expect(r.indicesAfterBuild).toContain("vector_idx"); // built
    expect(r.indicesAfterEnsure).toEqual(r.indicesAfterBuild); // ensure is a no-op, never drops
    // optimize folds appended rows into a delta sub-index (a second "vector_idx" entry);
    // the live index keeps serving — what matters is vector_idx is never ABSENT.
    expect(r.indicesAfterOptimize).toContain("vector_idx");
    expect(r.rowCount).toBe(155); // 150 + 5 churn — zero row loss
    expect(r.lex).toContain("s2:42:user"); // lexical finds it
    expect(r.vec).toContain("s2:42:user"); // semantic finds it
    expect(r.hyb).toBeGreaterThan(0); // fusion works
    expect(r.vectorOk).toBe(true); // vector data intact — no clobber
  });
});
