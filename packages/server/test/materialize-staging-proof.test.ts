import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "../../..");
const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-materialize-staging-proof-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const fileSha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const makeSourceDb = (path: string) => {
  const db = new Database(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE projects (
      project_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      raw_path TEXT
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      title TEXT,
      started_at TEXT,
      updated_at TEXT,
      source_path TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      tool_call_count INTEGER NOT NULL
    );
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
  const texts = [
    "cached local materialization proof one",
    "cached local materialization proof two",
  ];
  db.prepare("INSERT INTO projects(project_key, display_name, raw_path) VALUES (?, ?, ?)")
    .run("project-a", "Project A", "/tmp/project-a");
  db.prepare(
    `INSERT INTO sessions(session_id, project_key, provider, agent_name, title, started_at, updated_at, source_path, source_fingerprint, message_count, tool_call_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "codex:materialize-staging",
    "project-a",
    "codex",
    "codex",
    "Materialize staging fixture",
    "2026-07-04T00:00:00.000Z",
    "2026-07-04T00:01:00.000Z",
    "/tmp/materialize-staging.jsonl",
    "fingerprint",
    texts.length,
    0,
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages(session_id, seq, role, text, ts, project_key, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertCache = db.prepare(
    `INSERT INTO embedding_cache(model, content_hash, dimensions, text_bytes, vector_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [index, text] of texts.entries()) {
    insertMessage.run(
      "codex:materialize-staging",
      index + 1,
      index === 0 ? "user" : "assistant",
      text,
      `2026-07-04T00:00:3${index}.000Z`,
      "project-a",
      `raw-content-hash-${index + 1}`,
    );
    insertCache.run(
      "local-test-profile",
      sha256(`search_document: ${text}`),
      3,
      new TextEncoder().encode(`search_document: ${text}`).byteLength,
      JSON.stringify(index === 0 ? [1, 0, 0] : [0, 1, 0]),
      "2026-07-04T00:00:00.000Z",
      "2026-07-04T00:00:00.000Z",
    );
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
};

describe("materialize staging proof script", () => {
  test("runs materialization against a SQLite snapshot without mutating the source", async () => {
    const dir = tempDir();
    const sourceDb = join(dir, "source.sqlite");
    const outPath = join(dir, "proof.json");
    makeSourceDb(sourceDb);
    const sourceHashBefore = fileSha256(sourceDb);

    const proc = Bun.spawn([
      "bun",
      "scripts/materialize-staging-proof.mjs",
      "--source-db",
      sourceDb,
      "--out",
      outPath,
      "--cache-namespace",
      "local-test-profile",
      "--embedding-model",
      "test-model",
      "--embedding-dimensions",
      "3",
      "--limit",
      "1",
      "--max-batches",
      "10",
      "--timeout-ms",
      "10000",
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

    if (exitCode !== 0) {
      throw new Error(`materialize staging proof exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    expect(stderr).toBe("");
    expect(existsSync(outPath)).toBe(true);

    const stdoutReport = JSON.parse(stdout);
    const fileReport = JSON.parse(readFileSync(outPath, "utf8"));
    const workDir = stdoutReport.data.workDir;
    if (typeof workDir === "string") tempDirs.push(workDir);
    const workDb = join(workDir, "quasar.sqlite");
    const searchDir = join(workDir, "search.lance");
    const receiptPath = join(workDir, "materialization-closure.json");
    expect(stdoutReport.ok).toBe(true);
    expect(fileReport.ok).toBe(true);
    expect(stdoutReport.outPath).toBe(outPath);
    expect(stdoutReport.data).toMatchObject({
      sourceDb,
      workDir,
      workDb,
      searchDir,
      receiptPath,
      provider: "local",
    });
    expect(fileReport.data).toMatchObject({
      sourceDb,
      workDir,
      workDb,
      searchDir,
      receiptPath,
      provider: "local",
    });
    expect(existsSync(receiptPath)).toBe(true);
    expect(fileReport.data.materialization).toEqual(stdoutReport.data.materialization);
    expect(stdoutReport.data.materialization.data.batches).toBeGreaterThan(1);
    expect(stdoutReport.data.materialization.data.totals).toMatchObject({
      scanned: 2,
      cacheHits: 2,
      cacheMisses: 0,
      embedded: 0,
      sqliteVectorsUpserted: 2,
      lanceRowsUpserted: 2,
    });
    expect(stdoutReport.data.materialization.data.closure).toMatchObject({
      embedding: { provider: "local", activeEmbeddingProfile: "local-test-profile" },
      coverage: { vectorlessMessages: 0, vectorRows: 2 },
      lance: { rowCountMatches: true, lanceRowCount: 2 },
      gates: {
        zeroVectorlessMessages: true,
        zeroActiveEmbedMessageDeadLetters: true,
        lanceRowCountMatches: true,
        lanceRepairScanComplete: true,
      },
    });
    expect(fileSha256(sourceDb)).toBe(sourceHashBefore);

    const source = new Database(sourceDb, { readonly: true });
    const staged = new Database(workDb, { readonly: true });
    try {
      const sourceVectorTable = source
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_vectors'")
        .get();
      const stagedVectors = staged
        .query("SELECT COUNT(*) AS count FROM message_vectors")
        .get() as { count: number };
      expect(sourceVectorTable).toBeNull();
      expect(stagedVectors.count).toBe(2);
    } finally {
      source.close();
      staged.close();
    }
  }, 20_000);

  test("rejects caller-owned work directories", async () => {
    const dir = tempDir();
    const sourceDb = join(dir, "source.sqlite");
    const workDir = join(dir, "stage");
    const outPath = join(dir, "proof.json");
    makeSourceDb(sourceDb);

    const proc = Bun.spawn([
      "bun",
      "scripts/materialize-staging-proof.mjs",
      "--source-db",
      sourceDb,
      "--work-dir",
      workDir,
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

    expect(exitCode).toBe(2);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).error).toMatchObject({ message: "unknown option", flag: "--work-dir" });
    expect(existsSync(sourceDb)).toBe(true);
    expect(existsSync(workDir)).toBe(false);
  });

  test("rejects health responses from a server bound to another SQLite database", async () => {
    const dir = tempDir();
    const sourceDb = join(dir, "source.sqlite");
    const outPath = join(dir, "proof.json");
    makeSourceDb(sourceDb);

    const fakeServer = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true, data: { sqlite: "/data/quasar/live.sqlite" } }),
    });

    try {
      const proc = Bun.spawn([
        "bun",
        "scripts/materialize-staging-proof.mjs",
        "--source-db",
        sourceDb,
        "--out",
        outPath,
        "--port",
        String(fakeServer.port),
        "--timeout-ms",
        "1000",
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
      const report = JSON.parse(stdout);
      if (typeof report.error.workDir === "string") tempDirs.push(report.error.workDir);
      expect(report.error.message).toContain("staging server health SQLite path mismatch");
      expect(report.error.message).toContain("quasar-materialize-staging");
      expect(report.error.message).toContain("quasar.sqlite");
      expect(report.error.message).toContain("/data/quasar/live.sqlite");
      expect(existsSync(sourceDb)).toBe(true);
      expect(existsSync(report.error.workDb)).toBe(true);
    } finally {
      fakeServer.stop(true);
    }
  });
});
