import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
  buildIngestBatch,
  jsonByteLength,
  sanitizeIngestBatchForTransport,
} from "@skastr0/quasar-core";
import {
  DEFAULT_UPLOAD_GROUP_SIZE,
  MAX_BULK_UPLOAD_BODY_BYTES,
  MAX_UPLOAD_CHUNK_BATCH_BYTES,
  chunkIngestBatch,
  runIngestEffect,
} from "../src/commands/ingest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const cliPath = join(repoRoot, "packages/cli/src/cli.ts");

const writeJsonl = (path: string, records: readonly unknown[]) =>
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));

describe("CLI command graph", () => {
  test("runs ingest dry-run through the real command layer", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 3);

    const input = JSON.stringify({
      providers: ["pi"],
      roots: { pi: root },
      dryRun: true,
    });
    const result = await runCli(["ingest", "run", input], {
      cwd: repoRoot,
      env: {
        ...process.env,
        QUASAR_HOME: mkdtempSync(join(tmpdir(), "quasar-cli-home-")),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      ok: true;
      data: {
        dryRun: true;
        summary: { eventCount: number };
        sourceSafetyReport: { sourceReadMode: string; sourceMutations: unknown[] };
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.dryRun).toBe(true);
    expect(envelope.data.summary.eventCount).toBe(3);
    expect(envelope.data.sourceSafetyReport.sourceReadMode).toBe("read_only");
    expect(envelope.data.sourceSafetyReport.sourceMutations).toHaveLength(0);
  }, 20_000);

  test("chunks large ingest sessions with final expected-id cleanup metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 55);

    const batch = sanitizeIngestBatchForTransport(
      await buildIngestBatch({
        providers: ["pi"],
        roots: { pi: root },
        machine: { machineId: "machine:test", hostname: "test", platform: "test" },
      }),
    );
    const chunks = chunkIngestBatch(batch, {
      maxEventsPerChunk: 50,
      maxOperationsPerChunk: Number.MAX_SAFE_INTEGER,
    });
    const firstSession = chunks[0]!.sessions[0]! as (typeof batch.sessions)[number] & ChunkMetadata;
    const secondSession = chunks[1]!.sessions[0]! as (typeof batch.sessions)[number] & ChunkMetadata;

    expect(chunks).toHaveLength(2);
    expect(firstSession.partialSession).toBe(true);
    expect(firstSession.events).toHaveLength(50);
    expect(secondSession.partialSession).toBeUndefined();
    expect(secondSession.events).toHaveLength(5);
    expect(secondSession.eventCount).toBe(55);
    expect(secondSession.expectedEventIds).toHaveLength(55);
  }, 20_000);

  test("chunks ingest sessions by graph operation budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 55);

    const batch = sanitizeIngestBatchForTransport(
      await buildIngestBatch({
        providers: ["pi"],
        roots: { pi: root },
        machine: { machineId: "machine:test", hostname: "test", platform: "test" },
      }),
    );
    const chunks = chunkIngestBatch(batch, {
      maxEventsPerChunk: 50,
      maxOperationsPerChunk: 30,
    });

    expect(chunks.length).toBeGreaterThan(2);
    expect(
      chunks.slice(0, -1).every((chunk) => {
        const session = chunk.sessions[0] as
          | ((typeof batch.sessions)[number] & ChunkMetadata)
          | undefined;
        return session?.partialSession === true;
      }),
    ).toBe(true);
    expect(chunks.at(-1)?.sessions[0]?.events.length).toBeGreaterThan(0);
    expect((chunks.at(-1)?.sessions[0] as ChunkMetadata | undefined)?.partialSession).toBeUndefined();
    expect((chunks.at(-1)?.sessions[0] as ChunkMetadata | undefined)?.expectedEventIds).toHaveLength(55);
  }, 20_000);

  test("chunks a synthetic large corpus without dropping expected ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 1_000);

    const batch = sanitizeIngestBatchForTransport(
      await buildIngestBatch({
        providers: ["pi"],
        roots: { pi: root },
        machine: { machineId: "machine:test", hostname: "test", platform: "test" },
      }),
    );
    const chunks = chunkIngestBatch(batch, {
      maxEventsPerChunk: 50,
      maxOperationsPerChunk: 120,
    });

    expect(chunks.length).toBeGreaterThan(10);
    expect((chunks.at(-1)?.sessions[0] as ChunkMetadata | undefined)?.expectedEventIds).toHaveLength(1_000);
    expect(
      chunks.every((chunk) => (chunk.sessions[0]?.events.length ?? 0) <= 50),
    ).toBe(true);
    expect(chunks.every((chunk) => jsonByteLength(chunk) <= MAX_UPLOAD_CHUNK_BATCH_BYTES)).toBe(true);
  }, 20_000);

  test("keeps default bulk upload groups below local Convex isolate limits", () => {
    expect(DEFAULT_UPLOAD_GROUP_SIZE).toBeLessThanOrEqual(10);
  });

  test("runs non-dry-run ingest through job creation and bulk upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 12);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    const previousUploadGroupSize = process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE;
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE = "2";
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as Record<string, unknown>;
        return Effect.succeed({
          importJobId: "job:test",
          status: "queued",
          chunkCount: 0,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        const record = spec.body as { chunks?: Array<{ sequence?: number }> };
        return Effect.succeed({
          importJobId: "job:test",
          enqueuedCount: record.chunks?.length ?? 0,
          results: (record.chunks ?? []).map((chunk) => ({
            importJobId: "job:test",
            chunkId: `chunk:${chunk.sequence ?? 0}`,
            status: "pending",
            jobStatus: "running",
            enqueued: true,
          })),
        });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: { importJobId: "job:test", status: "succeeded" },
          chunks: [],
          failures: [],
          readiness: {
            total: 0,
            pending: 0,
            syncing: 0,
            ready: 0,
            skipped: 0,
            failed: 0,
            deadLetter: 0,
          },
        });
      }
      return Effect.fail(new Error(`Unexpected request ${spec.method} ${spec.path}`));
    }) as NonNullable<Parameters<typeof runIngestEffect>[1]>;

    const input = JSON.stringify({
      providers: ["pi"],
      roots: { pi: root },
    });
    type RunResult = {
      chunkCount: number;
      uploadedChunkCount: number;
      uploadGroupCount: number;
      results?: unknown;
    };
    let runResult: RunResult | undefined;
    try {
      runResult = await Effect.runPromise(
        runIngestEffect(input, requestClient) as Effect.Effect<unknown, unknown, never>,
      ) as RunResult;
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
      restoreEnv("QUASAR_INGEST_UPLOAD_GROUP_SIZE", previousUploadGroupSize);
    }
    const jobRequest = requests.find(
      (request) => request.method === "POST" && request.path === "/api/ingest/jobs",
    );
    const bulkRequests = requests.filter(
      (request) => request.method === "POST" && request.path === "/api/ingest/job-chunks-bulk",
    );
    const bulkBodies = bulkRequests.map((request) => request.body as {
      expectedChunkCount: number;
      chunks: Array<{ sequence: number; completeJob?: boolean }>;
    });
    const uploadedChunks = bulkBodies.flatMap((body) => body.chunks);
    expect(jobRequest?.body).toMatchObject({
      idempotencyKey: expect.stringMatching(/^import-job:/),
      expectedChunkCount: 3,
    });
    expect(bulkRequests).toHaveLength(2);
    expect(new Set(bulkBodies.map((body) => body.expectedChunkCount))).toEqual(new Set([3]));
    expect(uploadedChunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2]);
    expect(uploadedChunks.map((chunk) => chunk.completeJob === true)).toEqual([false, false, true]);
    expect(bulkBodies.every((body) => jsonByteLength(body) <= MAX_BULK_UPLOAD_BODY_BYTES)).toBe(true);
    expect(
      requests.some((request) => request.method === "GET" && request.path === "/api/ingest/jobs"),
    ).toBe(true);
    expect(runResult?.chunkCount).toBe(3);
    expect(runResult?.uploadedChunkCount).toBe(3);
    expect(runResult?.uploadGroupCount).toBe(2);
    expect(runResult?.results).toBeUndefined();
  }, 20_000);

  test("aborts non-dry-run ingest when sources change between planning and upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 2);
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        writePiFixture(root, 3);
        return Effect.succeed({
          importJobId: "job:changed",
          status: "queued",
          chunkCount: 0,
          expectedChunkCount: 1,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        return Effect.fail(new Error("bulk upload should not run after source mutation"));
      }
      return Effect.fail(new Error(`Unexpected request ${spec.method} ${spec.path}`));
    }) as NonNullable<Parameters<typeof runIngestEffect>[1]>;

    const input = JSON.stringify({
      providers: ["pi"],
      roots: { pi: root },
    });
    await expect(
      Effect.runPromise(
        runIngestEffect(input, requestClient) as Effect.Effect<unknown, unknown, never>,
      ),
    ).rejects.toThrow(/source changed between planning and upload/);
    expect(
      requests.some(
        (request) => request.method === "POST" && request.path === "/api/ingest/job-chunks-bulk",
      ),
    ).toBe(false);
  }, 20_000);
});

type ChunkMetadata = {
  readonly partialSession?: boolean;
  readonly eventCount?: number;
  readonly expectedEventIds?: readonly string[];
};

const writePiFixture = (root: string, count: number) =>
  writeJsonl(
    join(root, "session.jsonl"),
    Array.from({ length: count }, (_, index) => ({
      id: `p${index}`,
      role: index === 0 ? "user" : "assistant",
      content: index === 0 ? "start in quasar" : `message ${index}`,
      cwd: "/Users/a/Projects/quasar",
    })),
  );

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const runCli = (
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("bun", [cliPath, ...args], {
      cwd: options.cwd,
      env: options.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
