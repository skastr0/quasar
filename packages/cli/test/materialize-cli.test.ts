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
  command: "maintenance/embeddings/materialize-sqlite",
  data: {
    report: {
      scanned: 1,
      cacheHits: 1,
      cacheMisses: 0,
      embedded: 0,
      skipped: 0,
      sqliteVectorsUpserted: 1,
    },
    coverage: {
      searchableMessages: 3,
      vectorRows: 3,
      vectorlessMessages: 0,
      staleVectorRows: 0,
    },
    embedding: {
      provider: "local",
      profile: { cacheNamespace: "local:test", model: "test", dimensions: 768, task: "search_document" },
    },
  },
});

describe("materialize-embedding-vectors CLI", () => {
  test("receipt decision succeeds once vectorless messages reach zero", () => {
    const parsed = parseMaterializeBatch(materializeBatch());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.receipt.vectorlessMessages).toBe(0);
    expect(parsed.receipt.activeEmbeddingProfile).toBe("local:test");
    expect(decideMaterializeLoop(parsed.receipt)).toEqual({ kind: "success" });
  });

  test("receipt decision fails when no progress is made while vectorless messages remain", () => {
    const batch = materializeBatch();
    const parsed = parseMaterializeBatch({
      ...batch,
      data: {
        ...batch.data,
        report: { ...batch.data.report, scanned: 0 },
        coverage: { ...batch.data.coverage, vectorlessMessages: 5 },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const decision = decideMaterializeLoop(parsed.receipt);
    expect(decision.kind).toBe("failure");
    if (decision.kind !== "failure") return;
    expect(decision.error.message).toContain("no SQLite progress");
  });

  test("receipt decision continues while progress is made and vectorless messages remain", () => {
    const batch = materializeBatch();
    const parsed = parseMaterializeBatch({
      ...batch,
      data: {
        ...batch.data,
        coverage: { ...batch.data.coverage, vectorlessMessages: 5 },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(decideMaterializeLoop(parsed.receipt)).toEqual({ kind: "continue" });
  });

  test("receipt provider requirement rejects the wrong active provider", () => {
    const batch = materializeBatch();
    const parsed = parseMaterializeBatch({
      ...batch,
      data: {
        ...batch.data,
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

  test("until-empty drives the SQLite-only endpoint and writes an explicit durable closure receipt", async () => {
    const dir = tempDir();
    const outPath = join(dir, "receipt.json");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        expect(url.pathname).toBe("/maintenance/embeddings/materialize-sqlite");
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
        gates: {
          zeroVectorlessMessages: true,
        },
      });
    } finally {
      server.stop(true);
    }
  });

  test("single-batch materialization calls the SQLite-only endpoint", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        expect(url.pathname).toBe("/maintenance/embeddings/materialize-sqlite");
        expect(url.searchParams.get("limit")).toBe("25");
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
      expect(body.data.report.sqliteVectorsUpserted).toBe(1);
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
        expect(url.pathname).toBe("/maintenance/embeddings/materialize-sqlite");
        const batch = materializeBatch();
        return Response.json({
          ...batch,
          data: {
            ...batch.data,
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
        "--require-provider",
        "local",
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
