import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";

import {
  runSearchMaintenance,
  type SearchMaintenanceClient,
} from "../src/commands/search-maint";

class FakeMaintenanceClient implements SearchMaintenanceClient {
  reference: unknown;
  args: unknown;

  action(reference: unknown, args: unknown): Promise<unknown> {
    this.reference = reference;
    this.args = args;
    return Promise.resolve({
      createdIndexes: true,
      optimized: true,
      optimize: {
        tableName: "messages",
        stats: {
          compaction: { fragmentsRemoved: 0, fragmentsAdded: 1, filesRemoved: 0, filesAdded: 1 },
          prune: { bytesRemoved: 0, oldVersionsRemoved: 0 },
        },
      },
      stats: {
        tableName: "messages",
        rowCount: 1,
        versionCount: 1,
        disk: { totalBytes: 100, dataBytes: 80, indexBytes: 20, versionBytes: 0 },
        tableStats: { numRows: 1, totalBytes: 100, numIndices: 1 },
        indices: [{ name: "text_idx", indexType: "FTS", columns: ["text"] }],
      },
    });
  }
}

describe("search maintain command wiring", () => {
  test("calls the maintainSearch action with defaults", async () => {
    const client = new FakeMaintenanceClient();
    await runSearchMaintenance({
      client,
      actionSecret: "test-secret",
      createIndexes: true,
      createVectorIndex: true,
      replaceIndexes: false,
      optimize: true,
      cleanupOlderThanMs: 0,
    });

    expect(getFunctionName(client.reference as never)).toBe("search:maintainSearch");
    expect(client.args).toEqual({
      secret: "test-secret",
      createIndexes: true,
      createVectorIndex: true,
      replaceIndexes: false,
      optimize: true,
      cleanupOlderThanMs: 0,
    });
  });

  test("validates action secret before network calls", async () => {
    await expect(
      runSearchMaintenance({
        client: new FakeMaintenanceClient(),
        actionSecret: "",
        createIndexes: true,
        createVectorIndex: true,
        replaceIndexes: false,
        optimize: true,
        cleanupOlderThanMs: 0,
      }),
    ).rejects.toThrow(/Search maintenance requires QUASAR_ACTION_SECRET/);
  });
});
