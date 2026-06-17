import { afterEach, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer, makeLanceDbRuntime } from "../src/index";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "quasar-search-"));
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
});
