/**
 * indexGc.test.ts — Real-LanceDB GC safety tests. NO mocks.
 *
 * The critical invariant: gcSupersededIndexDirs never deletes a generation dir
 * referenced by ANY surviving manifest — for FTS, BTree, AND IVF_PQ alike.
 *
 * T1 (ivf_pq_survives): seed >= IVF_PQ_MIN_ROWS (65536) rows with real 1536-d
 * vectors so createMessageIndexes takes the useIvfPq branch and a genuine IVF_PQ
 * generation is written to _indices (auxiliary.idx present). After optimize+GC,
 * assert (a) the IVF_PQ dir still exists, (b) vectorSearch returns > 0 hits,
 * (c) ftsSearch returns > 0 hits. This closes the exact blind spot in the
 * reverted test: that test seeded < 65536 rows so no IVF_PQ was ever built.
 *
 * T2 (orphaned_deleted): inject a fake UUID dir into _indices (not in any
 * manifest), run GC, assert it is deleted while the real IVF_PQ dir survives.
 * Proves GC IS effective, not just a no-op.
 *
 * T3 (multi_cycle_bounds): 6 cycles of inject-fake→optimize+GC; assert fake dirs
 * are deleted every cycle, real index dirs stay bounded.
 *
 * T4 (fail_safe_paths): missing _versions → keep-all; unreadable manifest → keep-all;
 * non-UUID dir name → kept; zero manifests → keep-all.
 *
 * IVF_PQ NOTE: building a real IVF_PQ index on 66 000 × 1536-d vectors takes
 * ~30–120 s on typical hardware. This is accepted by design; T1+T2+T3 use a
 * 15-minute timeout.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MESSAGE_VECTOR_DIMENSIONS, LanceDb, makeLanceDbLayer } from "../src/lancedb";

// Matches the package-private constant in lancedb.ts.
const IVF_PQ_MIN_ROWS = 65_536;
// Slightly above the floor to avoid off-by-one on boundary counting.
const IVF_PQ_SEED_ROWS = 66_000;
// Batch size for inserts; keeps per-batch JS heap below ~12 MB (1000 × 1536 × 8 B).
const INSERT_BATCH = 1_000;

const tempDirs: string[] = [];

afterEach(async () => {
  // Best-effort: chmod any 000 files back first so rm succeeds.
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }).catch(() => {
        // If rm fails (e.g. permission-denied on test-created 000 files), try chmod first.
      }),
    ),
  );
});

/** Unit vector: position [i % dim] = 1, rest = 0. Gives diverse training data for IVF_PQ k-means. */
const makeVec1536 = (i: number): number[] =>
  Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, (_, d) =>
    d === i % DEFAULT_MESSAGE_VECTOR_DIMENSIONS ? 1.0 : 0.0,
  );

// ── T1 + T2 + T3: combined, share the expensive 66 000-row IVF_PQ setup ──────

describe("gcSupersededIndexDirs (real IVF_PQ)", () => {
  test(
    "ivf_pq_survives_gc, orphaned_deleted, multi_cycle_bounds",
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "quasar-gc-ivfpq-"));
      tempDirs.push(dataDir);
      const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));

      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const search = yield* LanceDb;
            const indicesPath = join(dataDir, "messages.lance", "_indices");

            // ── Seed IVF_PQ_SEED_ROWS rows (> IVF_PQ_MIN_ROWS = 65 536) ─────────
            console.log(`[indexGc] seeding ${IVF_PQ_SEED_ROWS} rows for IVF_PQ build…`);
            for (let batch = 0; batch < IVF_PQ_SEED_ROWS / INSERT_BATCH; batch++) {
              const rows = Array.from({ length: INSERT_BATCH }, (_, j) => {
                const idx = batch * INSERT_BATCH + j;
                return {
                  sessionId: `s${idx % 200}`,
                  seq: idx,
                  role: "user" as const,
                  projectKey: "gc-project",
                  provider: "codex",
                  text: `document ${idx} gc-needle`,
                  contentHash: `ch${idx}`,
                  vector: makeVec1536(idx),
                };
              });
              yield* search.upsertMessageRows({ rows });
            }

            const totalRows = yield* search.countRows({});
            console.log(`[indexGc] ${totalRows} rows seeded (need >= ${IVF_PQ_MIN_ROWS})`);
            expect(totalRows).toBeGreaterThanOrEqual(IVF_PQ_MIN_ROWS);

            // ── Build indexes: createMessageIndexes takes the useIvfPq branch ────
            console.log("[indexGc] building indexes (IVF_PQ + FTS + BTree)…");
            yield* search.createMessageIndexes({ includeVector: true });

            // Prove IVF_PQ was built: listIndices must return at least one IvfPq entry.
            const table = yield* search.openTable({});
            const indexList = yield* Effect.promise(() => table.listIndices());
            const ivfPqEntry = indexList.find((ix) => /pq/i.test(ix.indexType ?? ""));
            expect(ivfPqEntry).toBeDefined();
            console.log(`[indexGc] IVF_PQ index confirmed: name=${ivfPqEntry?.name} type=${ivfPqEntry?.indexType}`);

            // Prove IVF_PQ generation dir exists on disk with auxiliary.idx.
            const dirsAfterBuild = yield* Effect.promise(async () => {
              const entries = await readdir(indicesPath, { withFileTypes: true });
              return entries.filter((e) => e.isDirectory()).map((e) => e.name);
            });
            expect(dirsAfterBuild.length).toBeGreaterThan(0);

            // Find the dir that contains auxiliary.idx (IVF_PQ centroids file).
            let ivfPqDirName: string | undefined;
            for (const dir of dirsAfterBuild) {
              const files = yield* Effect.promise(() =>
                readdir(join(indicesPath, dir)).catch(() => [] as string[]),
              );
              if (files.includes("auxiliary.idx")) {
                ivfPqDirName = dir;
                break;
              }
            }
            expect(ivfPqDirName).toBeDefined();
            console.log(`[indexGc] IVF_PQ generation dir on disk: ${ivfPqDirName}`);

            // ── T1: optimize + GC → the LIVE IVF_PQ generation MUST survive ───────
            // optimize() creates a new compacted generation (Gen1) and prunes the old
            // manifest that referenced Gen0. GC then correctly deletes Gen0 (no longer
            // in any surviving manifest). The LIVE generation after GC is Gen1; it must
            // survive. We detect it by scanning for auxiliary.idx post-GC, not by
            // assuming Gen0 still exists.
            console.log("[indexGc] T1: running optimize + GC…");
            yield* search.optimize({ olderThanMs: 0, deleteUnverified: false });
            const gc1 = yield* search.gcSupersededIndexDirs({});
            console.log(`[indexGc] T1 GC: scanned=${gc1.scanned} referenced=${gc1.referenced} deleted=${gc1.deleted}`);

            // Find the CURRENT live IVF_PQ dir after GC (may differ from pre-GC ivfPqDirName).
            const dirsAfterGc1 = yield* Effect.promise(async () => {
              const entries = await readdir(indicesPath, { withFileTypes: true });
              return entries.filter((e) => e.isDirectory()).map((e) => e.name);
            });
            let liveIvfPqDir: string | undefined;
            for (const dir of dirsAfterGc1) {
              const files = yield* Effect.promise(() =>
                readdir(join(indicesPath, dir)).catch(() => [] as string[]),
              );
              if (files.includes("auxiliary.idx")) {
                liveIvfPqDir = dir;
                break;
              }
            }
            // The live IVF_PQ generation MUST still exist post-GC (semantic search not blanked).
            expect(liveIvfPqDir).toBeDefined();
            console.log(`[indexGc] T1 live IVF_PQ dir after GC: ${liveIvfPqDir} (was: ${ivfPqDirName})`);

            // vectorSearch must return hits (semantic search not blanked).
            const searchVec = makeVec1536(42);
            const vecHits = yield* search.vectorSearch({ vector: searchVec, limit: 5 });
            expect(vecHits.length).toBeGreaterThan(0);
            console.log(`[indexGc] T1 vectorSearch hits: ${vecHits.length}`);

            // ftsSearch must return hits.
            const ftsHits = yield* search.ftsSearch({ query: "gc-needle", limit: 5 });
            expect(ftsHits.length).toBeGreaterThan(0);
            console.log(`[indexGc] T1 ftsSearch hits: ${ftsHits.length}`);

            // ── T2: inject orphaned dir → GC must DELETE it while keeping IVF_PQ ─
            console.log("[indexGc] T2: injecting orphaned UUID dir…");
            const orphanUuid = "deadbeef-dead-beef-cafe-000000000000";
            yield* Effect.promise(() => mkdir(join(indicesPath, orphanUuid), { recursive: true }));

            const gc2 = yield* search.gcSupersededIndexDirs({});
            console.log(`[indexGc] T2 GC: scanned=${gc2.scanned} referenced=${gc2.referenced} deleted=${gc2.deleted}`);

            const dirsAfterGc2 = yield* Effect.promise(async () => {
              const entries = await readdir(indicesPath, { withFileTypes: true });
              return entries.filter((e) => e.isDirectory()).map((e) => e.name);
            });
            // Fake orphan must be gone.
            expect(dirsAfterGc2).not.toContain(orphanUuid);
            // Live IVF_PQ dir must still be present.
            expect(dirsAfterGc2).toContain(liveIvfPqDir!);
            expect(gc2.deleted).toBeGreaterThanOrEqual(1);
            console.log("[indexGc] T2 passed: orphaned dir deleted, live IVF_PQ dir kept");

            // ── T3: 6 cycles of inject-fake → optimize + GC → assert bounded ─────
            console.log("[indexGc] T3: multi-cycle bounds (6 cycles)…");
            const dirCountHistory: number[] = [];
            // The current live IVF_PQ dir may change each cycle (optimize creates Gen N+1,
            // GC prunes Gen N). We track it dynamically by scanning for auxiliary.idx.
            let currentIvfPqDir: string = liveIvfPqDir!;

            for (let cycle = 0; cycle < 6; cycle++) {
              // Pad to exactly 12 hex chars so the UUID is parseable (not treated as "keep").
              const fakeName = `cafecafe-0000-0000-0000-${String(cycle).padStart(12, "0")}`;
              yield* Effect.promise(() => mkdir(join(indicesPath, fakeName), { recursive: true }));

              // Add rows to give optimize something to fold.
              yield* search.upsertMessageRows({
                rows: Array.from({ length: 100 }, (_, j) => ({
                  sessionId: `cycle${cycle}-${j}`,
                  seq: IVF_PQ_SEED_ROWS + cycle * 100 + j,
                  role: "user" as const,
                  projectKey: "gc-project",
                  provider: "codex",
                  text: `cycle ${cycle} row ${j} gc-needle`,
                  contentHash: `cyc-${cycle}-${j}`,
                  vector: makeVec1536(cycle * 100 + j),
                })),
              });

              yield* search.optimize({ olderThanMs: 0, deleteUnverified: false });
              const gcC = yield* search.gcSupersededIndexDirs({});

              const dirsNow = yield* Effect.promise(async () => {
                const entries = await readdir(indicesPath, { withFileTypes: true });
                return entries.filter((e) => e.isDirectory()).map((e) => e.name);
              });

              // Fake dir for this cycle must be gone.
              expect(dirsNow).not.toContain(fakeName);

              // Find and verify the CURRENT live IVF_PQ dir (may have rotated to a new gen).
              let nextIvfPqDir: string | undefined;
              for (const dir of dirsNow) {
                const files = yield* Effect.promise(() =>
                  readdir(join(indicesPath, dir)).catch(() => [] as string[]),
                );
                if (files.includes("auxiliary.idx")) {
                  nextIvfPqDir = dir;
                  break;
                }
              }
              expect(nextIvfPqDir).toBeDefined();
              currentIvfPqDir = nextIvfPqDir!;

              dirCountHistory.push(dirsNow.length);
              console.log(
                `[indexGc] T3 cycle ${cycle}: dirs=${dirsNow.length} ivfPqDir=${currentIvfPqDir} gc.deleted=${gcC.deleted} gc.referenced=${gcC.referenced}`,
              );
            }

            // Dir count must stay bounded: at most 7 index types × 3 delta sub-indices = 21.
            const maxDirCount = Math.max(...dirCountHistory);
            console.log(`[indexGc] T3 max dir count across 6 cycles: ${maxDirCount}`);
            expect(maxDirCount).toBeLessThanOrEqual(7 * 3);

            // Search remains live through all cycles.
            const vecFinal = yield* search.vectorSearch({ vector: searchVec, limit: 5 });
            expect(vecFinal.length).toBeGreaterThan(0);
            const ftsFinal = yield* search.ftsSearch({ query: "gc-needle", limit: 5 });
            expect(ftsFinal.length).toBeGreaterThan(0);
            console.log("[indexGc] T3 passed: dirs bounded, search live through all cycles");
          }),
        );
      } finally {
        await runtime.dispose();
      }
    },
    15 * 60 * 1_000, // 15-minute timeout — IVF_PQ build on 66 000 × 1536d takes ~30-120 s
  );
});

// ── T4: fail-safe paths (fast, no IVF_PQ needed) ──────────────────────────────

describe("gcSupersededIndexDirs (fail-safe paths)", () => {
  test("missing _versions returns keep-all (scanned=N, deleted=0)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "quasar-gc-t4a-"));
    tempDirs.push(dataDir);

    // Manually create _indices dirs WITHOUT a _versions dir.
    const indicesDir = join(dataDir, "messages.lance", "_indices");
    const fakeUuids = [
      "aabbccdd-aabb-aabb-aabb-aabbccddeeff",
      "11223344-1122-1122-1122-112233445566",
    ];
    for (const uuid of fakeUuids) {
      await mkdir(join(indicesDir, uuid), { recursive: true });
    }
    // NO _versions dir created — gcSupersededIndexDirs must keep-all.

    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.gcSupersededIndexDirs({});
        }),
      );
      expect(result.deleted).toBe(0);
      expect(result.referenced).toBe(fakeUuids.length);
      expect(result.scanned).toBe(fakeUuids.length);
    } finally {
      await runtime.dispose();
    }
  });

  test("unreadable manifest causes abort → keep-all (deleted=0)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "quasar-gc-t4b-"));
    tempDirs.push(dataDir);
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));

    // Create a minimal real LanceDB table so _versions/manifests exist.
    await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "s1",
              seq: 1,
              role: "user",
              projectKey: "p",
              provider: "codex",
              text: "hello",
              contentHash: "hc1",
              vector: Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, () => 0.01),
            },
          ],
        });
        yield* search.createMessageIndexes({ includeVector: false });
      }),
    );

    const indicesDir = join(dataDir, "messages.lance", "_indices");
    const versionsDir = join(dataDir, "messages.lance", "_versions");

    // Inject a fake orphaned dir so GC has something to potentially delete.
    const orphanUuid = "orphan123-dead-beef-cafe-000000000000";
    await mkdir(join(indicesDir, orphanUuid), { recursive: true });

    // Make one manifest unreadable to trigger abort-keeps-all.
    const manifests = (await readdir(versionsDir)).filter((n) => n.endsWith(".manifest"));
    expect(manifests.length).toBeGreaterThan(0);
    const target = join(versionsDir, manifests[0]!);
    await chmod(target, 0o000);

    let result: { scanned: number; referenced: number; deleted: number };
    try {
      result = await runtime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.gcSupersededIndexDirs({});
        }),
      );
    } finally {
      // Restore permissions so afterEach cleanup succeeds.
      await chmod(target, 0o644).catch(() => { /* best-effort */ });
      await runtime.dispose();
    }

    // Unreadable manifest → abort → deleted=0, all kept.
    expect(result.deleted).toBe(0);
  });

  test("non-UUID dir name in _indices is always kept", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "quasar-gc-t4c-"));
    tempDirs.push(dataDir);
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));

    await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "s1",
              seq: 1,
              role: "user",
              projectKey: "p",
              provider: "codex",
              text: "hello",
              contentHash: "hc1",
              vector: Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, () => 0.01),
            },
          ],
        });
        yield* search.createMessageIndexes({ includeVector: false });
      }),
    );

    const indicesDir = join(dataDir, "messages.lance", "_indices");
    const strangeNames = ["not-a-uuid", "__special__"];
    for (const name of strangeNames) {
      await mkdir(join(indicesDir, name), { recursive: true });
    }

    let result: { scanned: number; referenced: number; deleted: number };
    try {
      result = await runtime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.gcSupersededIndexDirs({});
        }),
      );
    } finally {
      await runtime.dispose();
    }

    // Non-UUID dirs are treated as referenced (kept) — never deleted.
    expect(result.deleted).toBe(0);
    const remaining = (await readdir(indicesDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const name of strangeNames) {
      expect(remaining).toContain(name);
    }
  });

  test("zero manifests in _versions returns keep-all (deleted=0)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "quasar-gc-t4d-"));
    tempDirs.push(dataDir);
    const runtime = ManagedRuntime.make(makeLanceDbLayer({ dataDir }));

    await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* LanceDb;
        yield* search.upsertMessageRows({
          rows: [
            {
              sessionId: "s1",
              seq: 1,
              role: "user",
              projectKey: "p",
              provider: "codex",
              text: "hello",
              contentHash: "hc1",
              vector: Array.from({ length: DEFAULT_MESSAGE_VECTOR_DIMENSIONS }, () => 0.01),
            },
          ],
        });
        yield* search.createMessageIndexes({ includeVector: false });
      }),
    );

    const indicesDir = join(dataDir, "messages.lance", "_indices");
    const versionsDir = join(dataDir, "messages.lance", "_versions");

    // Inject an orphaned dir.
    const orphanUuid = "orphan456-dead-beef-cafe-000000000000";
    await mkdir(join(indicesDir, orphanUuid), { recursive: true });

    // Delete all manifests (leave the _versions dir but empty).
    const manifests = (await readdir(versionsDir)).filter((n) => n.endsWith(".manifest"));
    await Promise.all(manifests.map((m) => rm(join(versionsDir, m))));

    let result: { scanned: number; referenced: number; deleted: number };
    try {
      result = await runtime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.gcSupersededIndexDirs({});
        }),
      );
    } finally {
      await runtime.dispose();
    }

    // Zero manifests → cannot determine referenced set → keep-all.
    expect(result.deleted).toBe(0);
  });
});
