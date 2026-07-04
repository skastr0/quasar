import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { decideMaterializeLoop, parseMaterializeBatch } from "../src/materialize-receipt";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-materialize-cli-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const materializeBatch = () => ({
  ok: true,
  command: "maintenance/embeddings/materialize",
  data: {
    report: {
      scanned: 1,
      cacheHits: 1,
      cacheMisses: 0,
      embedded: 0,
      skipped: 0,
      sqliteVectorsUpserted: 1,
      lanceRowsUpserted: 1,
      lanceRowsRepaired: 2,
      lanceScan: { offset: 0, nextOffset: 2, scanned: 2, complete: true },
    },
    coverage: {
      semanticRows: 3,
      vectorRows: 3,
      vectorlessMessages: 0,
    },
    queue: {
      embedMessage: { kind: "embed-message", pending: 0, leased: 0, failed: 0 },
      byKind: [],
    },
    lance: {
      activeVectorTableName: "messages_active",
      divergence: {
        sqliteVectorRows: 3,
        lanceRowCount: 3,
        rowCountMatches: true,
        rowCountDelta: 0,
      },
    },
  },
});

describe("materialize-embedding-vectors CLI", () => {
  test("receipt decisions fail when dead letters remain", () => {
    const parsed = parseMaterializeBatch({
      ...materializeBatch(),
      data: {
        ...materializeBatch().data,
        queue: {
          embedMessage: { kind: "embed-message", pending: 0, leased: 0, failed: 1 },
          byKind: [],
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const decision = decideMaterializeLoop(parsed.receipt);
    expect(decision.kind).toBe("failure");
    if (decision.kind !== "failure") return;
    expect(decision.error.message).toContain("dead letters remain");
  });

  test("until-empty writes an explicit durable closure receipt", async () => {
    const dir = tempDir();
    const outPath = join(dir, "receipt.json");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        expect(url.pathname).toBe("/maintenance/embeddings/materialize");
        return Response.json(materializeBatch());
      },
    });

    try {
      const proc = Bun.spawn([
        "bun",
        "run",
        "src/cli.ts",
        "materialize-embedding-vectors",
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--until-empty",
        "--out",
        outPath,
      ], {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(existsSync(outPath)).toBe(true);

      const fromStdout = JSON.parse(stdout);
      const fromFile = JSON.parse(readFileSync(outPath, "utf8"));
      expect(fromFile).toEqual(fromStdout);
      expect(fromStdout.data.closure).toEqual({
        coverage: { vectorlessMessages: 0, vectorRows: 3 },
        queue: { embedMessage: { pending: 0, failed: 0 } },
        lance: {
          activeVectorTableName: "messages_active",
          sqliteVectorRows: 3,
          lanceRowCount: 3,
          rowCountMatches: true,
          rowCountDelta: 0,
          scanComplete: true,
          nextOffset: 2,
        },
        gates: {
          zeroVectorlessMessages: true,
          zeroEmbedMessageDeadLetters: true,
          lanceRowCountMatches: true,
          lanceRepairScanComplete: true,
        },
      });
    } finally {
      server.stop(true);
    }
  });
});
