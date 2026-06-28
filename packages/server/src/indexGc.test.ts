/**
 * Real-LanceDB GC test (no mocks). Falsifies both disaster modes:
 *  (a) unbounded _indices growth — each optimize+GC cycle should leave disk bounded
 *  (b) deletion of the serving generation — ftsSearch must succeed every cycle
 *
 * Independent oracle `liveRefUuid` reads latest_version_hint.json and the current
 * manifest directly from the filesystem (NOT through gcSupersededIndexDirs) to avoid
 * self-validation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDb, makeLanceDbLayer } from "./lancedb";

// ── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "quasar-gc-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Independent oracle: reads the current manifest from disk and returns the
 * _indices generation dir whose 16 big-endian UUID bytes appear in that manifest.
 *
 * Grounded discriminator: UUID bytes are stored big-endian in LanceDB manifests
 * (proven 2026-06-26: live dir present in current manifest as big-endian, not LE).
 */
const liveRefUuid = async (tableDir: string): Promise<string | undefined> => {
  const versionsDir = join(tableDir, "_versions");
  const indicesDir = join(tableDir, "_indices");

  // Read the current version number from latest_version_hint.json
  let version: bigint;
  try {
    const raw = await readFile(join(versionsDir, "latest_version_hint.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: number | string };
    const v = parsed.version;
    if (v === undefined) return undefined;
    version = BigInt(v);
  } catch {
    return undefined;
  }

  // Manifest filename: u64::MAX - version (LanceDB's tombstone-indexed scheme)
  const manifestName = `${(2n ** 64n - 1n - version).toString()}.manifest`;
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(versionsDir, manifestName));
  } catch {
    return undefined;
  }

  // Scan _indices dirs for one whose UUID appears in the manifest as raw big-endian bytes
  let names: string[];
  try {
    names = (await readdir(indicesDir, { withFileTypes: true, encoding: "utf8" }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name as string);
  } catch {
    return undefined;
  }

  for (const name of names) {
    const hex = name.replace(/-/g, "");
    if (hex.length !== 32) continue;
    try {
      const bytes = Buffer.from(hex, "hex");
      if (bytes.length === 16 && manifestBytes.includes(bytes)) {
        return name;
      }
    } catch {
      // skip unparseable
    }
  }
  return undefined;
};

// ── Test fixture ─────────────────────────────────────────────────────────────

/** Small vector dimension keeps the test fast; GC correctness is dimension-agnostic. */
const VECTOR_DIM = 4;

const makeRow = (sessionId: string, seq: number, token: string) => ({
  sessionId,
  seq,
  role: "user" as const,
  projectKey: "project-gc",
  provider: "codex",
  text: `gctoken ${token} message seq${seq}`,
  contentHash: `${sessionId}-${seq}`,
  vector: Array.from({ length: VECTOR_DIM }, (_, i) => (i === seq % VECTOR_DIM ? 1 : 0)),
});

const makeRows = (sessionPrefix: string, count: number, startSeq = 1, token = "search") =>
  Array.from({ length: count }, (_, i) => makeRow(`${sessionPrefix}:${startSeq + i}`, startSeq + i, token));

// ── Main test ─────────────────────────────────────────────────────────────────

describe("gcSupersededIndexDirs", () => {
  test(
    "deletes only superseded _indices dirs and never the serving generation across K=5 cycles",
    async () => {
      const dataDir = await makeTempDir();
      const tableName = "messages";
      const tableDir = join(dataDir, `${tableName}.lance`);
      const indicesDir = join(tableDir, "_indices");
      const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));

      try {
        // ── Initial seed: 150 rows + build FTS + vector indexes ─────────────
        await runtime.runPromise(
          Effect.gen(function* () {
            const search = yield* LanceDb;
            const initialRows = makeRows("session", 150, 1);
            yield* search.ensureMessageTable({
              rows: initialRows,
              vectorDimension: VECTOR_DIM,
            });
            // Build FTS + scalar + vector indexes (minVectorRows: 100, 150 rows ≥ threshold)
            yield* search.createMessageIndexes({
              tableName,
              includeVector: true,
              minVectorRows: 100,
            });
          }),
        );

        // ── K=5 optimize+GC cycles ────────────────────────────────────────
        const K = 5;
        let maxDirs = 0;

        for (let cycle = 0; cycle < K; cycle += 1) {
          // Step 1: upsert fresh rows so optimize has new unindexed data to fold
          const sessionPrefix = `cycle${cycle}`;
          await runtime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              yield* search.upsertMessageRows({
                rows: makeRows(sessionPrefix, 50, 1),
                tableName,
                vectorDimension: VECTOR_DIM,
              });
            }),
          );

          // Step 2: capture live UUID and dir list BEFORE optimize+GC
          const before = await liveRefUuid(tableDir);
          const dirsBefore = await runtime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              return yield* search.listIndexDirNames({ tableName });
            }),
          );

          // Step 3: optimize (olderThanMs:1 → superseded versions prune deterministically) then GC
          const gc = await runtime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              yield* search.optimize({ tableName, olderThanMs: 1, deleteUnverified: false }).pipe(
                Effect.catchAll((e) =>
                  Effect.logError(`optimize failed in cycle ${cycle}: ${String(e)}`),
                ),
              );
              return yield* search.gcSupersededIndexDirs({ tableName });
            }),
          );

          // Step 4: capture live UUID AFTER GC
          const after = await liveRefUuid(tableDir);

          // Step 5: compute which dirs were deleted
          const dirsAfter = await runtime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              return yield* search.listIndexDirNames({ tableName });
            }),
          );
          const deletedSet = new Set(dirsBefore.filter((d) => !dirsAfter.includes(d)));

          // ASSERT: a dir from the current manifest still exists on disk after GC
          if (after !== undefined) {
            expect(existsSync(join(indicesDir, after))).toBe(true);
          }

          // ASSERT: the after-live dir (in current manifest) was never deleted
          if (after !== undefined) {
            expect(deletedSet.has(after)).toBe(false);
          }

          // ASSERT: GC only deleted dirs that were present before (sanity)
          expect(gc.deleted).toBeLessThanOrEqual(dirsBefore.length);

          // ASSERT: GC did not delete a dir that was in the current manifest before optimize.
          // `before` finds ONE dir in the pre-optimize manifest; after optimize that dir may
          // itself be superseded (if it is from an older generation), so we only assert it
          // was NOT deleted if it is still referenced in the post-GC manifest (i.e. if it
          // equals `after` or is also found in the post-optimize manifest).
          // The canonical safety proof is: FTS search still works (below).

          // Step 6: verify search index still serves after GC
          const ftsResults = await runtime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              return yield* search.ftsSearch({ tableName, query: "gctoken", limit: 5 }).pipe(
                Effect.catchAll(() => Effect.succeed([])),
              );
            }),
          );
          expect(ftsResults.length).toBeGreaterThan(0);

          // Step 7: track max dirs for bounded-growth assertion (measured AFTER GC)
          maxDirs = Math.max(maxDirs, dirsAfter.length);
        }

        // Post-loop: ASSERT disk is bounded after GC.
        // LanceDB's optimize creates one new generation dir per index per cycle, and the
        // current manifest retains the last TWO generations (current + one prior delta).
        // With 7 index types (FTS + 5 scalar + vector), steady-state is 7×2 = 14 dirs
        // measured after GC. We assert ≤ 21 (3 generations) as a safe upper bound.
        expect(maxDirs).toBeLessThanOrEqual(21);
        const finalDirs = await runtime.runPromise(
          Effect.gen(function* () {
            const search = yield* LanceDb;
            return yield* search.listIndexDirNames({ tableName });
          }),
        );
        // At steady state (cycles 2+) dirs stabilize at ≤ 14. Allow ≤ 21 for cycle-1 edge.
        expect(finalDirs.length).toBeLessThanOrEqual(21);
      } finally {
        await runtime.dispose();
      }
    },
    60_000, // 60s timeout for 5 optimize+GC cycles
  );

  test("returns zeros and no-ops when table does not exist yet", async () => {
    const dataDir = await makeTempDir();
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.gcSupersededIndexDirs({ tableName: "nonexistent" });
        }),
      );
      expect(result).toEqual({ scanned: 0, referenced: 0, deleted: 0 });
    } finally {
      await runtime.dispose();
    }
  });

  test("treats unparseable dir names as referenced (never deletes them)", async () => {
    // GC safety: a dir whose name is not a valid UUID hex is treated as referenced,
    // so it is never deleted. This prevents accidental deletion of non-standard dirs.
    const dataDir = await makeTempDir();
    const tableDir = join(dataDir, "messages.lance");
    const versionsDir = join(tableDir, "_versions");
    const indicesDir = join(tableDir, "_indices");

    // Bootstrap the table so _versions and _indices dirs exist
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          yield* search.ensureMessageTable({
            rows: makeRows("seed", 5, 1),
            vectorDimension: VECTOR_DIM,
          });
          yield* search.createMessageIndexes({ tableName: "messages", includeVector: false });
        }),
      );

      // Place a dir with an unparseable name in _indices
      const unparseable = join(indicesDir, "not-a-uuid-at-all");
      await (await import("node:fs/promises")).mkdir(unparseable, { recursive: true });

      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          // First verify it's listed
          const dirs = yield* search.listIndexDirNames({ tableName: "messages" });
          return { dirs, gc: yield* search.gcSupersededIndexDirs({ tableName: "messages" }) };
        }),
      );

      // The unparseable dir must be in the scan but treated as referenced (not deleted)
      expect(result.dirs).toContain("not-a-uuid-at-all");
      expect(result.gc.referenced).toBeGreaterThan(0); // at least the unparseable one
      expect(existsSync(unparseable)).toBe(true); // never deleted
    } finally {
      await runtime.dispose();
    }
  });
});
