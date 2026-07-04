import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { decideMaterializeLoop, parseMaterializeBatch, requireMaterializeProvider } from "../src/materialize-receipt";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-materialize-cli-"));
  tempDirs.push(dir);
  return dir;
};

const repoRoot = join(import.meta.dir, "../../..");

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
      activeEmbedMessage: { kind: "embed-message", pending: 0, leased: 0, failed: 0 },
      activeEmbeddingProfile: "local:test",
      byKind: [],
    },
    embedding: {
      provider: "local",
      profile: { cacheNamespace: "local:test", model: "test", dimensions: 768, task: "search_document" },
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

  test("receipt decisions ignore legacy global dead letters when the active profile is clean", () => {
    const parsed = parseMaterializeBatch({
      ...materializeBatch(),
      data: {
        ...materializeBatch().data,
        queue: {
          embedMessage: { kind: "embed-message", pending: 0, leased: 0, failed: 7 },
          activeEmbedMessage: { kind: "embed-message", pending: 0, leased: 0, failed: 0 },
          activeEmbeddingProfile: "local:test",
          byKind: [],
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.receipt.globalFailedEmbedMessages).toBe(7);
    expect(parsed.receipt.failedEmbedMessages).toBe(0);
    expect(decideMaterializeLoop(parsed.receipt)).toEqual({ kind: "success" });
  });

  test("receipt decisions fail when active-profile dead letters remain", () => {
    const parsed = parseMaterializeBatch({
      ...materializeBatch(),
      data: {
        ...materializeBatch().data,
        queue: {
          embedMessage: { kind: "embed-message", pending: 0, leased: 0, failed: 0 },
          activeEmbedMessage: { kind: "embed-message", pending: 0, leased: 0, failed: 1 },
          activeEmbeddingProfile: "local:test",
          byKind: [],
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const decision = decideMaterializeLoop(parsed.receipt);
    expect(decision.kind).toBe("failure");
    if (decision.kind !== "failure") return;
    expect(decision.error.message).toContain("active-profile");
  });

  test("receipt provider requirement rejects the wrong active provider", () => {
    const parsed = parseMaterializeBatch({
      ...materializeBatch(),
      data: {
        ...materializeBatch().data,
        embedding: {
          provider: "synthetic",
          profile: { cacheNamespace: "synthetic:test", model: "test", dimensions: 768, task: "search_document" },
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const error = requireMaterializeProvider(parsed.receipt, "local");
    expect(error?.message).toContain("wrong embedding provider");
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
        "--require-provider",
        "local",
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
        embedding: { provider: "local", activeEmbeddingProfile: "local:test" },
        coverage: { vectorlessMessages: 0, vectorRows: 3 },
        queue: {
          activeEmbeddingProfile: "local:test",
          embedMessage: { pending: 0, failed: 0 },
          globalEmbedMessage: { pending: 0, failed: 0 },
        },
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
          zeroActiveEmbedMessageDeadLetters: true,
          lanceRowCountMatches: true,
          lanceRepairScanComplete: true,
        },
      });
    } finally {
      server.stop(true);
    }
  });

  test("sqlite-only materialization command calls the SQLite-only endpoint", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        expect(url.pathname).toBe("/maintenance/embeddings/materialize-sqlite");
        expect(url.searchParams.get("limit")).toBe("25");
        return Response.json({
          ok: true,
          command: "maintenance/embeddings/materialize-sqlite",
          data: {
            report: {
              scanned: 2,
              cacheHits: 1,
              cacheMisses: 1,
              embedded: 1,
              skipped: 0,
              sqliteVectorsUpserted: 2,
            },
            coverage: { vectorlessMessages: 0, vectorRows: 2 },
          },
        });
      },
    });

    try {
      const proc = Bun.spawn([
        "bun",
        "run",
        "src/cli.ts",
        "materialize-sqlite-embedding-vectors",
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--limit",
        "25",
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
      const body = JSON.parse(stdout);
      expect(body.command).toBe("maintenance/embeddings/materialize-sqlite");
      expect(body.data.report.sqliteVectorsUpserted).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("server materialize wrapper rejects synthetic receipts when local is required", async () => {
    const dir = tempDir();
    const outPath = join(dir, "receipt.json");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        expect(url.pathname).toBe("/maintenance/embeddings/materialize");
        return Response.json({
          ...materializeBatch(),
          data: {
            ...materializeBatch().data,
            embedding: {
              provider: "synthetic",
              profile: { cacheNamespace: "synthetic:test", model: "test", dimensions: 768, task: "search_document" },
            },
          },
        });
      },
    });

    try {
      const proc = Bun.spawn([
        "bun",
        "scripts/server-ops.mjs",
        "materialize",
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--out",
        outPath,
      ], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(existsSync(outPath)).toBe(false);

      const failure = JSON.parse(stdout);
      expect(failure.ok).toBe(false);
      expect(failure.error.message).toContain("wrong embedding provider");
      expect(failure.error.details).toMatchObject({
        expected: "embedding.provider = local",
        received: "synthetic",
      });
    } finally {
      server.stop(true);
    }
  });
});
