import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "../../..");
const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-replay-cache-staging-proof-test-"));
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
    "cached replay proof one",
    "uncached replay proof middle",
    "cached replay proof two",
  ];
  db.prepare("INSERT INTO projects(project_key, display_name, raw_path) VALUES (?, ?, ?)")
    .run("project-a", "Project A", "/tmp/project-a");
  db.prepare(
    `INSERT INTO sessions(session_id, project_key, provider, agent_name, title, started_at, updated_at, source_path, source_fingerprint, message_count, tool_call_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "codex:replay-cache-staging",
    "project-a",
    "codex",
    "codex",
    "Replay cache staging fixture",
    "2026-07-04T00:00:00.000Z",
    "2026-07-04T00:01:00.000Z",
    "/tmp/replay-cache-staging.jsonl",
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
      "codex:replay-cache-staging",
      index + 1,
      index === 1 ? "assistant" : "user",
      text,
      `2026-07-04T00:00:3${index}.000Z`,
      "project-a",
      `raw-content-hash-${index + 1}`,
    );
    if (index !== 1) {
      insertCache.run(
        "cache-replay-test-profile",
        sha256(`search_document: ${text}`),
        3,
        new TextEncoder().encode(`search_document: ${text}`).byteLength,
        JSON.stringify(index === 0 ? [1, 0, 0] : [0, 1, 0]),
        "2026-07-04T00:00:00.000Z",
        "2026-07-04T00:00:00.000Z",
      );
    }
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
};

describe("replay cache staging proof script", () => {
  test("replays cached vectors into a SQLite snapshot without provider calls or source mutation", async () => {
    const dir = tempDir();
    const sourceDb = join(dir, "source.sqlite");
    const outPath = join(dir, "proof.json");
    makeSourceDb(sourceDb);
    const sourceHashBefore = fileSha256(sourceDb);

    const proc = Bun.spawn([
      "bun",
      "scripts/replay-cache-staging-proof.mjs",
      "--source-db",
      sourceDb,
      "--out",
      outPath,
      "--limit",
      "2",
      "--max-batches",
      "10",
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
      throw new Error(`replay cache staging proof exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    expect(stderr).toBe("");
    expect(existsSync(outPath)).toBe(true);

    const stdoutReport = JSON.parse(stdout);
    const fileReport = JSON.parse(readFileSync(outPath, "utf8"));
    const workDir = stdoutReport.data.workDir;
    if (typeof workDir === "string") tempDirs.push(workDir);
    const workDb = join(workDir, "quasar.sqlite");

    expect(stdoutReport.ok).toBe(true);
    expect(fileReport.ok).toBe(true);
    expect(stdoutReport.outPath).toBe(outPath);
    expect(stdoutReport.data).toMatchObject({
      sourceDb,
      workDir,
      workDb,
      cache: {
        model: "cache-replay-test-profile",
        dimensions: 3,
        rows: 2,
      },
      expected: {
        cacheRows: 2,
        searchableMessages: 3,
        replayableMessagesByDocumentHash: 2,
        missingReplayableMessages: 1,
        rawContentHashMatches: 0,
      },
      replay: {
        batchCount: 2,
        totals: {
          scanned: 4,
          cacheHits: 2,
          missingCache: 2,
          sqliteVectorsUpserted: 2,
        },
        providerCalls: 0,
        finalCoverage: {
          searchableMessages: 3,
          vectorRows: 2,
          vectorlessMessages: 1,
          staleVectorRows: 0,
        },
      },
      gates: {
        initialSqliteVectorsZero: true,
        upsertedReplayableMessages: true,
        reachedCacheReplayCeiling: true,
        remainingEqualsUncached: true,
        staleVectorRowsZero: true,
        providerCallsBlocked: true,
      },
    });
    expect(fileReport.data.replay).toEqual(stdoutReport.data.replay);
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
      "scripts/replay-cache-staging-proof.mjs",
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
});
