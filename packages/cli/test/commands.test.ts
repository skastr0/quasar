import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
  buildIngestBatch,
  CONVEX_SAFE_INGEST_BUDGETS,
  jsonByteLength,
  projectSessionIntelligenceGraphId,
  sanitizeIngestBatchForTransport,
  streamIngestBatches,
} from "@skastr0/quasar-core";
import {
  DEFAULT_UPLOAD_GROUP_SIZE,
  MAX_BULK_UPLOAD_BODY_BYTES,
  MAX_EVENTS_PER_CHUNK,
  MAX_OPERATIONS_PER_CHUNK,
  MAX_UPLOAD_CHUNK_BATCH_BYTES,
  chunkIngestBatch,
  ingestBatchPayloadHash,
  ingestChunkIdempotencyKey,
  isIdleUploadIncompleteImportJob,
  runIngestEffect,
  sanitizeInspectionBatch,
  sanitizeUploadChunk,
} from "../src/commands/ingest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const cliPath = join(repoRoot, "packages/cli/src/cli.ts");
const testMachine = { machineId: "machine:test", hostname: "test", platform: "test" };

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

  test("rejects loose ingest option numbers at the CLI boundary", async () => {
    const result = await runCli([
      "ingest",
      "run",
      JSON.stringify({ providers: ["pi"], limit: 0, dryRun: true }),
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        QUASAR_HOME: mkdtempSync(join(tmpdir(), "quasar-cli-home-")),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected a positive integer");
  }, 20_000);

  test("runs source discovery with a session skip window", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    for (const name of ["a", "b", "c"]) {
      writeJsonl(join(root, `session-${name}.jsonl`), [
        {
          id: name,
          role: "user",
          content: `message ${name}`,
          cwd: "/Users/a/Projects/quasar",
        },
      ]);
    }

    const result = await runCli([
      "sources",
      "discover",
      JSON.stringify({ providers: ["pi"], roots: { pi: root }, limit: 1, skip: 1 }),
    ], {
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
        sessionCount: number;
        eventCount: number;
        selection: { limit: number; skip: number; defaultLimitApplied: boolean };
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.sessionCount).toBe(1);
    expect(envelope.data.eventCount).toBe(1);
    expect(envelope.data.selection).toEqual({
      limit: 1,
      skip: 1,
      defaultLimitApplied: false,
    });
  }, 20_000);

  test("reports when source discovery uses the default one-session sample", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-codex-"));
    writeCodexSessionFile(root, "a", "first codex session");
    writeCodexSessionFile(root, "b", "second codex session");

    const result = await runCli([
      "sources",
      "discover",
      JSON.stringify({ providers: ["codex"], roots: { codex: root } }),
    ], {
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
        sessionCount: number;
        selection: { limit: number; skip: number; defaultLimitApplied: boolean };
      };
    };
    expect(envelope.data.sessionCount).toBe(1);
    expect(envelope.data.selection).toEqual({
      limit: 1,
      skip: 0,
      defaultLimitApplied: true,
    });
  }, 20_000);

  test("plans ingest through the streamed manifest path with explicit skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-codex-"));
    writeCodexSessionFile(root, "a", "first codex session");
    writeCodexSessionFile(root, "b", "second codex session");

    const result = await runCli([
      "ingest",
      "plan",
      JSON.stringify({ providers: ["codex"], roots: { codex: root }, limit: 1, skip: 1 }),
    ], {
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
        sessionCount: number;
        chunkCount: number;
        selection: { limit: number; skip: number };
        providerSummaries: Array<{ provider: string; sessionCount: number; eventCount: number }>;
        sessionSampleLimit: number;
        sessionSamplesTruncated: boolean;
        sessionSamples: Array<{ sourcePath: string; eventCount: number }>;
      };
    };
    expect(envelope.data.sessionCount).toBe(1);
    expect(envelope.data.chunkCount).toBeGreaterThan(0);
    expect(envelope.data.selection).toEqual({ limit: 1, skip: 1 });
    expect(envelope.data.providerSummaries).toEqual([
      expect.objectContaining({ provider: "codex", sessionCount: 1 }),
    ]);
    expect(envelope.data.sessionSampleLimit).toBeGreaterThan(0);
    expect(envelope.data.sessionSamplesTruncated).toBe(false);
    expect(envelope.data.sessionSamples).toHaveLength(1);
    expect(envelope.data.sessionSamples[0]?.sourcePath).toContain("-b.jsonl");
    expect(envelope.data.sessionSamples[0]?.eventCount).toBeGreaterThan(0);
  }, 20_000);

  test("caps streamed ingest plan session samples while preserving exact provider counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-codex-"));
    for (let index = 0; index < 30; index += 1) {
      writeCodexSessionFile(root, String(index).padStart(2, "0"), `codex session ${index}`);
    }

    const result = await runCli([
      "ingest",
      "plan",
      JSON.stringify({ providers: ["codex"], roots: { codex: root }, limit: 30 }),
    ], {
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
        sessionCount: number;
        providerSummaries: Array<{ provider: string; sessionCount: number; eventCount: number }>;
        sessionSampleLimit: number;
        sessionSamplesTruncated: boolean;
        sessionSamples: Array<{ sourcePath: string }>;
      };
    };
    expect(envelope.data.sessionCount).toBe(30);
    expect(envelope.data.providerSummaries).toEqual([
      expect.objectContaining({ provider: "codex", sessionCount: 30, eventCount: 60 }),
    ]);
    expect(envelope.data.sessionSampleLimit).toBe(25);
    expect(envelope.data.sessionSamples).toHaveLength(25);
    expect(envelope.data.sessionSamplesTruncated).toBe(true);
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
    expect(firstSession.expectedEventIds).toBeUndefined();
    expect(firstSession.events).toHaveLength(50);
    expect(secondSession.partialSession).toBeUndefined();
    expect(secondSession.events).toHaveLength(5);
    expect(secondSession.eventCount).toBe(55);
    expect(secondSession.expectedEventIds).toHaveLength(55);
  }, 20_000);

  test("projects cleanup expected ids through the graph id contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 2);
    const unsafeSentinel = "CLI_EXPECTED_ID_SENTINEL";
    const hugeId = (prefix: string) => `${prefix}:${"x".repeat(5_000)}:${unsafeSentinel}`;
    const rawSessionId = hugeId("session");
    const rawEventIds = [hugeId("event:0"), hugeId("event:1")];

    const batch = await buildIngestBatch({
      providers: ["pi"],
      roots: { pi: root },
      machine: { machineId: "machine:test", hostname: "test", platform: "test" },
    });
    const session = batch.sessions[0]!;
    const unsafeBatch = {
      ...batch,
      sessions: [
        {
          ...session,
          id: rawSessionId,
          nativeSessionId: hugeId("native"),
          events: session.events.slice(0, 2).map((event, index) => ({
            ...event,
            id: rawEventIds[index]!,
            sessionId: rawSessionId,
          })),
        },
      ],
    };

    const chunks = chunkIngestBatch(unsafeBatch, {
      maxEventsPerChunk: 1,
      maxOperationsPerChunk: Number.MAX_SAFE_INTEGER,
    });
    const finalSession = chunks.at(-1)!.sessions[0]! as (typeof session) & ChunkMetadata;

    expect(finalSession.expectedEventIds).toEqual(
      rawEventIds.map((id) => projectSessionIntelligenceGraphId("event", id)),
    );
    expect(JSON.stringify(finalSession)).not.toContain(unsafeSentinel);
  }, 20_000);

  test("sanitizes validate and dry-run batches through the Convex row contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 1);
    const hugeHostname = "cli-host-trash-".repeat(2_000);
    const hugeRoot = `/Users/a/${"cli-source-root-trash/".repeat(2_000)}`;

    const batch = await buildIngestBatch({
      providers: ["pi"],
      roots: { pi: root },
      machine: {
        machineId: "machine:test",
        hostname: hugeHostname,
        platform: "test",
      },
    });
    const inspected = sanitizeInspectionBatch({
      ...batch,
      sourceRoots: [
        {
          provider: "pi",
          adapterId: "pi:test",
          rootPath: hugeRoot,
          machineId: "machine:test",
          discoveredAt: "2026-06-09T00:00:00.000Z",
        },
      ],
    });

    expect(jsonByteLength(inspected.machine)).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.machineRecordBytes,
    );
    expect(jsonByteLength(inspected.sourceRoots[0])).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.sourceRootRecordBytes,
    );
    expect(inspected.machine.hostname?.length).toBeLessThan(hugeHostname.length);
    expect(inspected.sourceRoots[0]?.rootPath.length).toBeLessThan(hugeRoot.length);
  }, 20_000);

  test("hashes upload chunks after stable Convex-boundary sanitization", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 1);

    const batch = sanitizeIngestBatchForTransport(
      await buildIngestBatch({
        providers: ["pi"],
        roots: { pi: root },
        machine: testMachine,
      }),
    );
    const [chunk] = chunkIngestBatch(batch);
    expect(chunk).toBeDefined();
    const omittedLargeText = JSON.stringify({
      __quasarOmitted: { reason: "object_byte_budget", byteLength: 16_966 },
      content: "already-omitted-upload-content".repeat(700),
    });
    const uploadChunk = {
      ...chunk!,
      sessions: chunk!.sessions.map((session) => ({
        ...session,
        events: session.events.map((event) => ({
          ...event,
          contentBlocks: [
            {
              id: `${event.id}:block:large`,
              sequence: 0,
              kind: "text" as const,
              text: omittedLargeText,
            },
          ],
        })),
      })),
    };

    const sanitized = sanitizeUploadChunk(uploadChunk);
    const sanitizedAgain = sanitizeUploadChunk(sanitized);

    expect(ingestBatchPayloadHash(uploadChunk)).not.toBe(ingestBatchPayloadHash(sanitized));
    expect(ingestBatchPayloadHash(sanitizedAgain)).toBe(ingestBatchPayloadHash(sanitized));
    expect(JSON.stringify(sanitized)).toContain("__quasarOmitted");
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

  test("does not duplicate fan-out edges into the source event chunk", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 5);

    const batch = sanitizeIngestBatchForTransport(
      await buildIngestBatch({
        providers: ["pi"],
        roots: { pi: root },
        machine: { machineId: "machine:test", hostname: "test", platform: "test" },
      }),
    );
    const session = batch.sessions[0]!;
    const sourceEvent = session.events[0]!;
    const fanOutEdges = session.events.slice(1).map((target, index) => ({
      id: `edge:fanout:${index}`,
      sessionId: session.id,
      machineId: session.machineId,
      provider: session.provider,
      agentName: session.agentName,
      projectIdentityKey: session.projectIdentity.projectIdentityKey,
      kind: "parent" as const,
      fromEventId: sourceEvent.id,
      toEventId: target.id,
    }));
    const chunks = chunkIngestBatch(
      {
        ...batch,
        sessions: [{ ...session, sessionEdges: fanOutEdges }],
      },
      {
        maxEventsPerChunk: 1,
        maxOperationsPerChunk: Number.MAX_SAFE_INTEGER,
      },
    );

    expect(chunks[0]?.sessions[0]?.sessionEdges).toHaveLength(0);
    expect(
      chunks.flatMap((chunk) => chunk.sessions[0]?.sessionEdges ?? []),
    ).toHaveLength(fanOutEdges.length);
    for (const chunk of chunks) {
      expect(jsonByteLength(chunk)).toBeLessThanOrEqual(MAX_UPLOAD_CHUNK_BATCH_BYTES);
    }
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

  test("splits upload chunks by byte budget after sanitization", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 1);

    const batch = sanitizeIngestBatchForTransport(
      await buildIngestBatch({
        providers: ["pi"],
        roots: { pi: root },
        machine: { machineId: "machine:test", hostname: "test", platform: "test" },
      }),
    );
    const baseSession = batch.sessions[0]!;
    const baseEvent = baseSession.events[0]!;
    const largeEvents = Array.from({ length: 30 }, (_, index) => ({
      ...baseEvent,
      id: `event:large:${index}`,
      nativeEventId: `native:large:${index}`,
      sequence: index,
      contentText: `large event ${index}`,
      contentBlocks: [
        {
          id: `block:large:${index}`,
          sequence: 0,
          kind: "text" as const,
          text: `${index}:`.repeat(24 * 1024),
        },
      ],
    }));

    const chunks = chunkIngestBatch(
      {
        ...batch,
        sessions: [
          {
            ...baseSession,
            events: largeEvents,
            toolCalls: [],
            sessionEdges: [],
            usageRecords: [],
            artifacts: [],
          },
        ],
      },
      {
        maxEventsPerChunk: 50,
        maxOperationsPerChunk: Number.MAX_SAFE_INTEGER,
      },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => jsonByteLength(chunk) <= MAX_UPLOAD_CHUNK_BATCH_BYTES)).toBe(true);
    expect(chunks.reduce((sum, chunk) => sum + (chunk.sessions[0]?.events.length ?? 0), 0)).toBe(30);
  }, 20_000);

  test("defers cleanup metadata when final reconciliation would exceed upload budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 1);

    const batch = sanitizeIngestBatchForTransport(
      await buildIngestBatch({
        providers: ["pi"],
        roots: { pi: root },
        machine: { machineId: "machine:test", hostname: "test", platform: "test" },
      }),
    );
    const baseSession = batch.sessions[0]!;
    const baseEvent = baseSession.events[0]!;
    const largeEvents = Array.from({ length: 4_000 }, (_, index) => ({
      ...baseEvent,
      id: `event:${index}:${"x".repeat(200)}`,
      nativeEventId: `native:${index}`,
      sequence: index,
      contentText: `message ${index}`,
      contentBlocks: [],
    }));
    const chunks = chunkIngestBatch(
      {
        ...batch,
        sessions: [
          {
            ...baseSession,
            events: largeEvents,
            toolCalls: [],
            sessionEdges: [],
            usageRecords: [],
            artifacts: [],
          },
        ],
      },
      {
        maxEventsPerChunk: 50,
        maxOperationsPerChunk: Number.MAX_SAFE_INTEGER,
      },
    );
    const lastSession = chunks.at(-1)?.sessions[0] as
      | (ChunkMetadata & { readonly deferCleanup?: boolean })
      | undefined;

    expect(lastSession?.deferCleanup).toBe(true);
    expect(lastSession?.expectedEventIds).toBeUndefined();
    expect(chunks.every((chunk) => jsonByteLength(chunk) <= MAX_UPLOAD_CHUNK_BATCH_BYTES)).toBe(true);
  }, 30_000);

  test("keeps default bulk upload groups below local Convex isolate limits", () => {
    expect(DEFAULT_UPLOAD_GROUP_SIZE).toBeLessThanOrEqual(10);
  });

  test("keeps default ingest chunks below Convex mutation row budgets", () => {
    expect(MAX_EVENTS_PER_CHUNK).toBeLessThanOrEqual(10);
    expect(MAX_OPERATIONS_PER_CHUNK).toBeLessThanOrEqual(40);
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
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:test", scheduled: true });
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
      scheduleWorker?: boolean;
      chunks: Array<{ sequence: number; completeJob?: boolean }>;
    });
    const scheduleRequests = requests.filter(
      (request) => request.method === "POST" && request.path === "/api/ingest/jobs/schedule",
    );
    const uploadedChunks = bulkBodies.flatMap((body) => body.chunks);
    expect(jobRequest?.body).toMatchObject({
      sourceIdentityKey: expect.stringMatching(/^import-job:/),
      idempotencyKey: expect.stringMatching(/^import-job:/),
      chunkPayloadFingerprint: expect.any(String),
      expectedChunkCount: 3,
    });
    const startBody = jobRequest?.body as {
      sourceIdentityKey?: string;
      idempotencyKey?: string;
    } | undefined;
    expect(startBody?.idempotencyKey).toBe(startBody?.sourceIdentityKey);
    expect(bulkRequests).toHaveLength(2);
    expect(new Set(bulkBodies.map((body) => body.expectedChunkCount))).toEqual(new Set([3]));
    expect(new Set(bulkBodies.map((body) => body.scheduleWorker))).toEqual(new Set([false]));
    expect(uploadedChunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2]);
    expect(uploadedChunks.map((chunk) => chunk.completeJob === true)).toEqual([false, false, true]);
    expect(bulkBodies.every((body) => jsonByteLength(body) <= MAX_BULK_UPLOAD_BODY_BYTES)).toBe(true);
    expect(
      requests.some((request) => request.method === "GET" && request.path === "/api/ingest/jobs"),
    ).toBe(true);
    expect(scheduleRequests).toHaveLength(1);
    expect(runResult?.chunkCount).toBe(3);
    expect(runResult?.uploadedChunkCount).toBe(3);
    expect(runResult?.uploadGroupCount).toBe(2);
    expect(runResult?.results).toBeUndefined();
  }, 20_000);

  test("skips resume status paging for brand-new import jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 12);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    const previousUploadGroupSize = process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE;
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE = "2";
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    let uploaded = false;
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as Record<string, unknown>;
        return Effect.succeed({
          importJobId: "job:new",
          status: "queued",
          chunkCount: 0,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        uploaded = true;
        const record = spec.body as { chunks?: Array<{ sequence?: number }> };
        return Effect.succeed({
          importJobId: "job:new",
          enqueuedCount: record.chunks?.length ?? 0,
          results: (record.chunks ?? []).map((chunk) => ({
            importJobId: "job:new",
            chunkId: `chunk:${chunk.sequence ?? 0}`,
            status: "pending",
            jobStatus: "running",
            enqueued: true,
          })),
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:new", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        if (!uploaded) return Effect.fail(new Error("resume status should not run before upload"));
        return Effect.succeed({
          job: { importJobId: "job:new", status: "running" },
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

    try {
      await Effect.runPromise(
        runIngestEffect(
          JSON.stringify({ providers: ["pi"], roots: { pi: root } }),
          requestClient,
        ) as Effect.Effect<unknown, unknown, never>,
      );
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
      restoreEnv("QUASAR_INGEST_UPLOAD_GROUP_SIZE", previousUploadGroupSize);
    }

    expect(requests.findIndex((request) => request.method === "GET")).toBeGreaterThan(
      requests.findIndex((request) => request.path === "/api/ingest/job-chunks-bulk"),
    );
  }, 20_000);

  test("classifies idle incomplete uploads without waiting for worker drain", () => {
    expect(
      isIdleUploadIncompleteImportJob({
        jobStatus: "running",
        job: {
          expectedChunkCount: 40_301,
          uploadedChunkCount: 300,
          terminalChunkCount: 300,
          inFlightChunkCount: 0,
        },
      }),
    ).toBe(true);
    expect(
      isIdleUploadIncompleteImportJob({
        jobStatus: "running",
        job: {
          expectedChunkCount: 40_301,
          uploadedChunkCount: 300,
          terminalChunkCount: 299,
          inFlightChunkCount: 1,
        },
      }),
    ).toBe(false);
    expect(
      isIdleUploadIncompleteImportJob({
        jobStatus: "succeeded",
        job: {
          expectedChunkCount: 300,
          uploadedChunkCount: 300,
          terminalChunkCount: 300,
          inFlightChunkCount: 0,
        },
      }),
    ).toBe(false);
  });

  test("does not upload when a previous slice is still draining", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 12);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as Record<string, unknown>;
        return Effect.succeed({
          importJobId: "job:draining",
          status: "running",
          chunkCount: 2,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:draining", scheduled: true });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        return Effect.fail(new Error("bulk upload should wait for prior drain"));
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: {
            importJobId: "job:draining",
            status: "running",
            uploadedChunkCount: 2,
            succeededChunkCount: 1,
            failedChunkCount: 0,
          },
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

    try {
      await expect(
        Effect.runPromise(
          runIngestEffect(
            JSON.stringify({
              providers: ["pi"],
              roots: { pi: root },
              drainTimeoutMs: 0,
            }),
            requestClient,
          ) as Effect.Effect<unknown, unknown, never>,
        ),
      ).rejects.toThrow(/still has 1 in-flight chunk/);
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
    }

    expect(
      requests.some((request) => request.method === "POST" && request.path === "/api/ingest/jobs/schedule"),
    ).toBe(true);
    expect(
      requests.some((request) => request.method === "POST" && request.path === "/api/ingest/job-chunks-bulk"),
    ).toBe(false);
  }, 20_000);

  test("waits for uploaded slices to drain after scheduling the worker once", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 12);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    const previousUploadGroupSize = process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE;
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE = "1";
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    let statusReads = 0;
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as Record<string, unknown>;
        return Effect.succeed({
          importJobId: "job:drain-after-upload",
          status: "queued",
          chunkCount: 0,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        const record = spec.body as { chunks?: Array<{ sequence?: number }> };
        return Effect.succeed({
          importJobId: "job:drain-after-upload",
          enqueuedCount: record.chunks?.length ?? 0,
          results: (record.chunks ?? []).map((chunk) => ({
            importJobId: "job:drain-after-upload",
            chunkId: `chunk:${chunk.sequence ?? 0}`,
            status: "pending",
            jobStatus: "running",
            enqueued: true,
          })),
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:drain-after-upload", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        statusReads += 1;
        const succeededChunkCount = statusReads >= 2 ? 2 : 0;
        return Effect.succeed({
          job: {
            importJobId: "job:drain-after-upload",
            status: "running",
            uploadedChunkCount: 2,
            succeededChunkCount,
            failedChunkCount: 0,
          },
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

    type RunResult = {
      drain?: { afterUpload?: { timedOut: boolean; inFlightChunkCount: number } };
    };
    let runResult: RunResult | undefined;
    try {
      runResult = await Effect.runPromise(
        runIngestEffect(
          JSON.stringify({
            providers: ["pi"],
            roots: { pi: root },
            maxUploadChunks: 2,
            drainPollIntervalMs: 1,
            drainTimeoutMs: 1_000,
          }),
          requestClient,
        ) as Effect.Effect<unknown, unknown, never>,
      ) as RunResult;
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
      restoreEnv("QUASAR_INGEST_UPLOAD_GROUP_SIZE", previousUploadGroupSize);
    }

    const scheduleRequests = requests.filter(
      (request) => request.method === "POST" && request.path === "/api/ingest/jobs/schedule",
    );
    expect(statusReads).toBe(2);
    expect(scheduleRequests).toHaveLength(1);
    expect(runResult?.drain?.afterUpload).toMatchObject({
      timedOut: false,
      inFlightChunkCount: 0,
    });
  }, 20_000);

  test("resumes non-dry-run ingest after already uploaded chunks", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 12);
    const plannedHashes: string[] = [];
    for await (const plannedBatch of streamIngestBatches({
      providers: ["pi"],
      roots: { pi: root },
      machine: testMachine,
    })) {
      plannedHashes.push(
        ...chunkIngestBatch(plannedBatch, {
          maxEventsPerChunk: 5,
          maxOperationsPerChunk: 120,
        }).map(sanitizeUploadChunk).map(ingestBatchPayloadHash),
      );
    }
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    const previousUploadGroupSize = process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE;
    const previousQuasarHome = process.env.QUASAR_HOME;
    const quasarHome = mkdtempSync(join(tmpdir(), "quasar-cli-home-"));
    writeMachineIdentity(quasarHome);
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE = "2";
    process.env.QUASAR_HOME = quasarHome;
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as Record<string, unknown>;
        return Effect.succeed({
          importJobId: "job:resume",
          status: "running",
          chunkCount: 1,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        const record = spec.body as { chunks?: Array<{ sequence?: number }> };
        return Effect.succeed({
          importJobId: "job:resume",
          enqueuedCount: record.chunks?.length ?? 0,
          results: (record.chunks ?? []).map((chunk) => ({
            importJobId: "job:resume",
            chunkId: `chunk:${chunk.sequence ?? 0}`,
            status: "pending",
            jobStatus: "running",
            enqueued: true,
          })),
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:resume", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: { importJobId: "job:resume", status: "succeeded" },
          chunks: [
            {
              sequence: 0,
              payloadHash: plannedHashes[0],
              idempotencyKey: ingestChunkIdempotencyKey(
                "job:resume",
                0,
                plannedHashes[0]!,
              ),
              payloadStored: true,
              status: "pending",
            },
          ],
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
    type ResumeResult = {
      uploadedChunkCount: number;
      uploadedThisRunCount: number;
      skippedUploadedChunkCount: number;
    };
    let runResult: ResumeResult | undefined;
    try {
      runResult = await Effect.runPromise(
        runIngestEffect(input, requestClient) as Effect.Effect<unknown, unknown, never>,
      ) as ResumeResult;
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
      restoreEnv("QUASAR_INGEST_UPLOAD_GROUP_SIZE", previousUploadGroupSize);
      restoreEnv("QUASAR_HOME", previousQuasarHome);
    }
    const bulkBodies = requests
      .filter((request) => request.method === "POST" && request.path === "/api/ingest/job-chunks-bulk")
      .map((request) => request.body as {
        chunks: Array<{ sequence: number; completeJob?: boolean }>;
      });
    const uploadedChunks = bulkBodies.flatMap((body) => body.chunks);

    expect(uploadedChunks.map((chunk) => chunk.sequence)).toEqual([1, 2]);
    expect(uploadedChunks.map((chunk) => chunk.completeJob === true)).toEqual([false, true]);
    expect(runResult?.uploadedChunkCount).toBe(3);
    expect(runResult?.uploadedThisRunCount).toBe(2);
    expect(runResult?.skippedUploadedChunkCount).toBe(1);
    expect(
      requests.some(
        (request) => request.method === "POST" && request.path === "/api/ingest/jobs/schedule",
      ),
    ).toBe(true);
  }, 20_000);

  test("rejects an incompatible server chunk before uploading", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 12);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    const previousUploadGroupSize = process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE;
    const previousQuasarHome = process.env.QUASAR_HOME;
    const quasarHome = mkdtempSync(join(tmpdir(), "quasar-cli-home-"));
    writeMachineIdentity(quasarHome);
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE = "2";
    process.env.QUASAR_HOME = quasarHome;
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as Record<string, unknown>;
        return Effect.succeed({
          importJobId: "job:mismatch",
          status: "running",
          chunkCount: 1,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        const record = spec.body as { chunks?: Array<{ sequence?: number }> };
        return Effect.succeed({
          importJobId: "job:mismatch",
          enqueuedCount: record.chunks?.length ?? 0,
          results: (record.chunks ?? []).map((chunk) => ({
            importJobId: "job:mismatch",
            chunkId: `chunk:${chunk.sequence ?? 0}`,
            status: "pending",
            jobStatus: "running",
            enqueued: true,
          })),
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:mismatch", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: { importJobId: "job:mismatch", status: "running" },
          chunks: [
            {
              sequence: 0,
              payloadHash: "mismatched",
              payloadStored: true,
              status: "pending",
            },
          ],
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
    try {
      await expect(
        Effect.runPromise(
          runIngestEffect(input, requestClient) as Effect.Effect<unknown, unknown, never>,
        ),
      ).rejects.toThrow(/incompatible chunk at sequence 0/);
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
      restoreEnv("QUASAR_INGEST_UPLOAD_GROUP_SIZE", previousUploadGroupSize);
      restoreEnv("QUASAR_HOME", previousQuasarHome);
    }
    const uploadedChunks = requests
      .filter((request) => request.method === "POST" && request.path === "/api/ingest/job-chunks-bulk")
      .flatMap((request) => (
        request.body as { chunks: Array<{ sequence: number; completeJob?: boolean }> }
      ).chunks);

    expect(uploadedChunks).toEqual([]);
  }, 20_000);

  test("reuploads from a repairable failed server chunk", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 12);
    const plannedBatch = sanitizeIngestBatchForTransport(
      await buildIngestBatch({
        providers: ["pi"],
        roots: { pi: root },
        machine: testMachine,
      }),
    );
    const plannedHashes = chunkIngestBatch(plannedBatch, {
      maxEventsPerChunk: 5,
      maxOperationsPerChunk: 120,
    }).map(sanitizeUploadChunk).map(ingestBatchPayloadHash);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    const previousUploadGroupSize = process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE;
    const previousQuasarHome = process.env.QUASAR_HOME;
    const quasarHome = mkdtempSync(join(tmpdir(), "quasar-cli-home-"));
    writeMachineIdentity(quasarHome);
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE = "2";
    process.env.QUASAR_HOME = quasarHome;
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as Record<string, unknown>;
        return Effect.succeed({
          importJobId: "job:repair",
          status: "running",
          chunkCount: 1,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        const record = spec.body as { chunks?: Array<{ sequence?: number }> };
        return Effect.succeed({
          importJobId: "job:repair",
          enqueuedCount: record.chunks?.length ?? 0,
          results: (record.chunks ?? []).map((chunk) => ({
            importJobId: "job:repair",
            chunkId: `chunk:${chunk.sequence ?? 0}`,
            status: "pending",
            jobStatus: "running",
            enqueued: true,
          })),
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:repair", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: { importJobId: "job:repair", status: "running" },
          chunks: [
            {
              sequence: 0,
              payloadHash: plannedHashes[0],
              idempotencyKey: ingestChunkIdempotencyKey(
                "job:repair",
                0,
                plannedHashes[0]!,
              ),
              payloadStored: false,
              status: "failed",
            },
          ],
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
    type ResumeResult = {
      uploadedThisRunCount: number;
      skippedUploadedChunkCount: number;
    };
    let runResult: ResumeResult | undefined;
    try {
      runResult = await Effect.runPromise(
        runIngestEffect(input, requestClient) as Effect.Effect<unknown, unknown, never>,
      ) as ResumeResult;
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
      restoreEnv("QUASAR_INGEST_UPLOAD_GROUP_SIZE", previousUploadGroupSize);
      restoreEnv("QUASAR_HOME", previousQuasarHome);
    }
    const uploadedChunks = requests
      .filter((request) => request.method === "POST" && request.path === "/api/ingest/job-chunks-bulk")
      .flatMap((request) => (
        request.body as { chunks: Array<{ sequence: number; completeJob?: boolean }> }
      ).chunks);

    expect(uploadedChunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2]);
    expect(runResult?.uploadedThisRunCount).toBe(3);
    expect(runResult?.skippedUploadedChunkCount).toBe(0);
  }, 20_000);

  test("schedules the import worker when every chunk was already uploaded", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 12);
    const plannedBatch = sanitizeIngestBatchForTransport(
      await buildIngestBatch({
        providers: ["pi"],
        roots: { pi: root },
        machine: testMachine,
      }),
    );
    const plannedHashes = chunkIngestBatch(plannedBatch, {
      maxEventsPerChunk: 5,
      maxOperationsPerChunk: 120,
    }).map(sanitizeUploadChunk).map(ingestBatchPayloadHash);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    const previousUploadGroupSize = process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE;
    const previousQuasarHome = process.env.QUASAR_HOME;
    const quasarHome = mkdtempSync(join(tmpdir(), "quasar-cli-home-"));
    writeMachineIdentity(quasarHome);
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE = "2";
    process.env.QUASAR_HOME = quasarHome;
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as Record<string, unknown>;
        return Effect.succeed({
          importJobId: "job:complete-upload",
          status: "running",
          chunkCount: plannedHashes.length,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        return Effect.fail(new Error("bulk upload should not run for an uploaded job"));
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:complete-upload", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: { importJobId: "job:complete-upload", status: "running" },
          chunks: plannedHashes.map((payloadHash, sequence) => ({
            sequence,
            payloadHash,
            idempotencyKey: ingestChunkIdempotencyKey(
              "job:complete-upload",
              sequence,
              payloadHash,
            ),
            payloadStored: true,
            status: "pending",
          })),
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
    type ResumeResult = {
      uploadComplete: boolean;
      uploadedThisRunCount: number;
      skippedUploadedChunkCount: number;
    };
    let runResult: ResumeResult | undefined;
    try {
      runResult = await Effect.runPromise(
        runIngestEffect(input, requestClient) as Effect.Effect<unknown, unknown, never>,
      ) as ResumeResult;
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
      restoreEnv("QUASAR_INGEST_UPLOAD_GROUP_SIZE", previousUploadGroupSize);
      restoreEnv("QUASAR_HOME", previousQuasarHome);
    }

    expect(
      requests.some(
        (request) => request.method === "POST" && request.path === "/api/ingest/job-chunks-bulk",
      ),
    ).toBe(false);
    expect(
      requests.some(
        (request) => request.method === "POST" && request.path === "/api/ingest/jobs/schedule",
      ),
    ).toBe(true);
    expect(runResult?.uploadComplete).toBe(true);
    expect(runResult?.uploadedThisRunCount).toBe(0);
    expect(runResult?.skippedUploadedChunkCount).toBe(3);
  }, 20_000);

  test("bounds non-dry-run upload slices without completing the job", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    writePiFixture(root, 12);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    const previousUploadGroupSize = process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE;
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE = "1";
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    let expectedChunkCount = 0;
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as Record<string, unknown>;
        expectedChunkCount = Number(record.expectedChunkCount);
        return Effect.succeed({
          importJobId: "job:slice",
          status: "running",
          chunkCount: 0,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        const record = spec.body as { chunks?: Array<{ sequence?: number }> };
        return Effect.succeed({
          importJobId: "job:slice",
          enqueuedCount: record.chunks?.length ?? 0,
          results: (record.chunks ?? []).map((chunk) => ({
            importJobId: "job:slice",
            chunkId: `chunk:${chunk.sequence ?? 0}`,
            status: "pending",
            jobStatus: "running",
            enqueued: true,
          })),
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:slice", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: {
            importJobId: "job:slice",
            status: "running",
            expectedChunkCount,
            uploadedChunkCount: 2,
            terminalChunkCount: 2,
            inFlightChunkCount: 0,
            uploadComplete: false,
            missingUploadChunkCount: expectedChunkCount - 2,
          },
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
      maxUploadChunks: 2,
    });
    type SliceResult = {
      uploadedChunkCount: number;
      uploadedThisRunCount: number;
      uploadComplete: boolean;
      uploadStoppedEarly: boolean;
      uploadStatus: {
        uploadIncomplete: boolean;
        uploadComplete: boolean;
        uploadedChunkCount: number;
        terminalChunkCount: number;
        inFlightChunkCount: number;
        missingUploadChunkCount: number;
      };
    };
    let runResult: SliceResult | undefined;
    try {
      runResult = await Effect.runPromise(
        runIngestEffect(input, requestClient) as Effect.Effect<unknown, unknown, never>,
      ) as SliceResult;
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
      restoreEnv("QUASAR_INGEST_UPLOAD_GROUP_SIZE", previousUploadGroupSize);
    }
    const uploadedChunks = requests
      .filter((request) => request.method === "POST" && request.path === "/api/ingest/job-chunks-bulk")
      .flatMap((request) => (
        request.body as { chunks: Array<{ sequence: number; completeJob?: boolean }> }
      ).chunks);
    const bulkRequests = requests.filter(
      (request) => request.method === "POST" && request.path === "/api/ingest/job-chunks-bulk",
    );
    const scheduleRequests = requests.filter(
      (request) => request.method === "POST" && request.path === "/api/ingest/jobs/schedule",
    );

    expect(bulkRequests).toHaveLength(2);
    expect(
      bulkRequests.every(
        (request) => (request.body as { scheduleWorker?: boolean }).scheduleWorker === false,
      ),
    ).toBe(true);
    expect(scheduleRequests).toHaveLength(1);
    expect(requests.indexOf(scheduleRequests[0]!)).toBeGreaterThan(
      requests.lastIndexOf(bulkRequests[bulkRequests.length - 1]!),
    );
    expect(uploadedChunks.map((chunk) => chunk.sequence)).toEqual([0, 1]);
    expect(uploadedChunks.map((chunk) => chunk.completeJob === true)).toEqual([false, false]);
    expect(runResult?.uploadedChunkCount).toBe(2);
    expect(runResult?.uploadedThisRunCount).toBe(2);
    expect(runResult?.uploadComplete).toBe(false);
    expect(runResult?.uploadStoppedEarly).toBe(true);
    expect(runResult?.uploadStatus).toMatchObject({
      uploadIncomplete: true,
      uploadComplete: false,
      uploadedChunkCount: 2,
      terminalChunkCount: 2,
      inFlightChunkCount: 0,
      missingUploadChunkCount: 1,
    });
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
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: { importJobId: "job:changed", status: "queued" },
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

  test("uploads from a Codex source snapshot when the live root changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-codex-"));
    writeCodexFixture(root, 2);
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        writeCodexFixture(root, 3);
        const record = spec.body as Record<string, unknown>;
        return Effect.succeed({
          importJobId: "job:snapshot",
          status: "queued",
          chunkCount: 0,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        const record = spec.body as { chunks?: Array<{ sequence?: number }> };
        return Effect.succeed({
          importJobId: "job:snapshot",
          enqueuedCount: record.chunks?.length ?? 0,
          results: (record.chunks ?? []).map((chunk) => ({
            importJobId: "job:snapshot",
            chunkId: `chunk:${chunk.sequence ?? 0}`,
            status: "pending",
            jobStatus: "running",
            enqueued: true,
          })),
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:snapshot", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: { importJobId: "job:snapshot", status: "succeeded" },
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

    type SnapshotRunResult = {
      uploadedChunkCount: number;
      sourceSnapshot?: { enabled: boolean; copiedProviders: readonly string[] };
      sourceSafetyReport: { sourceMutations: readonly unknown[] };
    };
    const input = JSON.stringify({
      providers: ["codex"],
      roots: { codex: root },
      snapshotSources: true,
    });
    const runResult = await Effect.runPromise(
      runIngestEffect(input, requestClient) as Effect.Effect<unknown, unknown, never>,
    ) as SnapshotRunResult;
    const uploadedSession = requests.flatMap((request) => {
      if (request.method !== "POST" || request.path !== "/api/ingest/job-chunks-bulk") {
        return [];
      }
      return ((request.body as {
      chunks?: Array<{ batch?: { sessions?: Array<{ sourcePath?: string; events?: unknown[] }> } }>;
      }).chunks ?? []).flatMap((chunk) => chunk.batch?.sessions ?? []);
    }).find((session) => session.sourcePath !== undefined);

    expect(runResult.uploadedChunkCount).toBeGreaterThan(0);
    expect(runResult.sourceSnapshot).toMatchObject({
      enabled: true,
      copiedProviders: ["codex"],
    });
    expect(runResult.sourceSafetyReport.sourceMutations.length).toBeGreaterThan(0);
    expect(uploadedSession?.sourcePath).toContain(root);
    expect(uploadedSession?.events).toHaveLength(3);
  }, 20_000);

  test("resumes bounded ingest from a durable source generation after live root changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-codex-"));
    const quasarHome = mkdtempSync(join(tmpdir(), "quasar-cli-home-"));
    writeMachineIdentity(quasarHome);
    writeCodexFixture(root, 12);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousMaxEvents = process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK;
    const previousUploadGroupSize = process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE;
    const previousQuasarHome = process.env.QUASAR_HOME;
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_INGEST_MAX_EVENTS_PER_CHUNK = "5";
    process.env.QUASAR_INGEST_UPLOAD_GROUP_SIZE = "1";
    process.env.QUASAR_HOME = quasarHome;
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const uploadedChunks: Array<{ sequence: number; idempotencyKey: string; completeJob?: boolean }> = [];
    const sourceIdentityKeys: string[] = [];
    const idempotencyKeys: string[] = [];
    const chunkPayloadFingerprints: string[] = [];
    const expectedChunkCounts: number[] = [];
    const machineIds: string[] = [];
    let startCount = 0;
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        startCount += 1;
        const record = spec.body as {
          manifest?: { machine?: { machineId?: string } };
          sourceIdentityKey?: string;
          idempotencyKey?: string;
          chunkPayloadFingerprint?: string;
          expectedChunkCount?: number;
        };
        if (record.manifest?.machine?.machineId !== undefined) {
          machineIds.push(record.manifest.machine.machineId);
        }
        if (record.sourceIdentityKey !== undefined) sourceIdentityKeys.push(record.sourceIdentityKey);
        if (record.idempotencyKey !== undefined) idempotencyKeys.push(record.idempotencyKey);
        if (record.chunkPayloadFingerprint !== undefined) {
          chunkPayloadFingerprints.push(record.chunkPayloadFingerprint);
        }
        if (record.expectedChunkCount !== undefined) expectedChunkCounts.push(record.expectedChunkCount);
        return Effect.succeed({
          importJobId: "job:generation",
          status: "running",
          chunkCount: startCount === 1 ? 0 : 1,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        const record = spec.body as {
          chunks?: Array<{ sequence: number; idempotencyKey: string; completeJob?: boolean }>;
        };
        uploadedChunks.push(...(record.chunks ?? []));
        return Effect.succeed({
          importJobId: "job:generation",
          enqueuedCount: record.chunks?.length ?? 0,
          results: (record.chunks ?? []).map((chunk) => ({
            importJobId: "job:generation",
            chunkId: `chunk:${chunk.sequence}`,
            status: "pending",
            jobStatus: "running",
            enqueued: true,
          })),
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:generation", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: {
            importJobId: "job:generation",
            status: "running",
            uploadedChunkCount: uploadedChunks.length,
            succeededChunkCount: uploadedChunks.length,
            failedChunkCount: 0,
          },
          chunks: uploadedChunks.map((chunk) => ({
            sequence: chunk.sequence,
            idempotencyKey: chunk.idempotencyKey,
            payloadStored: true,
            status: "pending",
          })),
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

    type GenerationResult = {
      chunkCount: number;
      uploadedThisRunCount: number;
      uploadComplete: boolean;
      ledger?: {
        path: string;
        uploadedPrefixCount: number;
        recordedUploadedChunkCount: number;
      };
      ingestGeneration?: { generationId: string; path: string };
    };
    let first: GenerationResult | undefined;
    let second: GenerationResult | undefined;
    try {
      first = await Effect.runPromise(
        runIngestEffect(
          JSON.stringify({
            providers: ["codex"],
            roots: { codex: root },
            snapshotSources: true,
            maxUploadChunks: 1,
          }),
          requestClient,
        ) as Effect.Effect<unknown, unknown, never>,
      ) as GenerationResult;
      const generationPath = first.ingestGeneration?.path;
      if (generationPath === undefined) throw new Error("missing ingest generation path");
      const generationDirectory = dirname(generationPath);
      const persisted = JSON.parse(readFileSync(generationPath, "utf8")) as {
        plan?: { chunkPayloadHashes?: unknown };
        chunkLedger?: { format?: unknown; path?: unknown; chunkCount?: unknown; byteLength?: unknown };
      };
      expect(persisted.plan?.chunkPayloadHashes).toBeUndefined();
      expect(persisted.chunkLedger).toMatchObject({
        format: "quasar.ingest-chunks-jsonl/v1",
        path: "chunks.ndjson",
        chunkCount: 5,
      });
      expect(typeof persisted.chunkLedger?.byteLength).toBe("number");
      const chunkLedgerPath = join(generationDirectory, "chunks.ndjson");
      expect(existsSync(chunkLedgerPath)).toBe(true);
      const ledgerLines = readFileSync(chunkLedgerPath, "utf8").trim().split("\n");
      expect(ledgerLines).toHaveLength(5);
      expect(JSON.parse(ledgerLines[1]!)?.payloadHash).toEqual(expect.any(String));
      writeCodexFixture(join(generationDirectory, "sources", "codex"), 20);
      writeCodexFixture(root, 20);
      writeMachineIdentity(quasarHome, {
        machineId: "machine:changed",
        hostname: "changed-host",
        platform: "test",
      });
      second = await Effect.runPromise(
        runIngestEffect(
          JSON.stringify({
            providers: ["codex"],
            roots: { codex: root },
            snapshotSources: true,
            maxUploadChunks: 4,
          }),
          requestClient,
        ) as Effect.Effect<unknown, unknown, never>,
      ) as GenerationResult;
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_INGEST_MAX_EVENTS_PER_CHUNK", previousMaxEvents);
      restoreEnv("QUASAR_INGEST_UPLOAD_GROUP_SIZE", previousUploadGroupSize);
      restoreEnv("QUASAR_HOME", previousQuasarHome);
    }

    expect(first?.chunkCount).toBe(5);
    expect(second?.chunkCount).toBe(5);
    expect(first?.uploadedThisRunCount).toBe(1);
    expect(second?.uploadedThisRunCount).toBe(4);
    expect(second?.uploadComplete).toBe(true);
    expect(sourceIdentityKeys).toHaveLength(2);
    expect(new Set(sourceIdentityKeys).size).toBe(1);
    expect(idempotencyKeys).toEqual(sourceIdentityKeys);
    expect(chunkPayloadFingerprints).toHaveLength(2);
    expect(new Set(chunkPayloadFingerprints).size).toBe(1);
    expect(expectedChunkCounts).toEqual([5, 5]);
    expect(machineIds).toEqual(["machine:test", "machine:test"]);
    expect(uploadedChunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(uploadedChunks.map((chunk) => chunk.completeJob === true)).toEqual([false, false, false, false, true]);
    expect(first?.ingestGeneration?.generationId).toBe(second?.ingestGeneration?.generationId);
    expect(first?.ingestGeneration?.path === undefined ? false : existsSync(first.ingestGeneration.path)).toBe(true);
    expect(second?.ledger).toMatchObject({
      uploadedPrefixCount: 5,
      recordedUploadedChunkCount: 5,
    });

    const ledgerRows = sqliteJson<{
      source_identity_key?: string;
      import_job_id?: string;
      expected_chunk_count?: number;
      status?: string;
      total?: number;
      acknowledged?: number;
      uploading?: number;
    }>(
      join(quasarHome, "ingest-ledger.sqlite"),
      `
        select source_identity_key, import_job_id, expected_chunk_count, status,
          null as total, null as acknowledged, null as uploading
        from ingest_attempts
        union all
        select null, null, null, null,
          count(*),
          sum(case when local_status = 'acknowledged' then 1 else 0 end),
          sum(case when local_status = 'uploading' then 1 else 0 end)
        from ingest_chunks
      `,
    );
    expect(ledgerRows[0]).toMatchObject({
      source_identity_key: sourceIdentityKeys[0],
      import_job_id: "job:generation",
      expected_chunk_count: 5,
      status: "running",
    });
    expect(ledgerRows[1]).toMatchObject({
      total: 5,
      acknowledged: 5,
      uploading: 0,
    });
  }, 40_000);

  test("rejects stale durable ingest generation identity versions", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-codex-"));
    const quasarHome = mkdtempSync(join(tmpdir(), "quasar-cli-home-"));
    const generationId = "generation:stale";
    const generationDirectory = join(
      quasarHome,
      "ingest-generations",
      "by-id",
      generationId,
    );
    writeMachineIdentity(quasarHome);
    mkdirSync(generationDirectory, { recursive: true });
    writeFileSync(
      join(generationDirectory, "generation.json"),
      JSON.stringify({
        schemaVersion: "quasar.ingest-generation/v1",
        generationId,
        intent: { identityVersion: "quasar.ingest-generation-identity/v3" },
      }),
    );
    const previousQuasarHome = process.env.QUASAR_HOME;
    process.env.QUASAR_HOME = quasarHome;
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      return Effect.fail(new Error(`Unexpected request ${spec.method} ${spec.path}`));
    }) as NonNullable<Parameters<typeof runIngestEffect>[1]>;

    try {
      await expect(
        Effect.runPromise(
          runIngestEffect(
            JSON.stringify({
              providers: ["codex"],
              roots: { codex: root },
              ingestGeneration: generationId,
            }),
            requestClient,
          ) as Effect.Effect<unknown, unknown, never>,
        ),
      ).rejects.toThrow(
        /uses quasar\.ingest-generation\/v1.*requires quasar\.ingest-generation\/v2.*fresh ingest generation/,
      );
    } finally {
      restoreEnv("QUASAR_HOME", previousQuasarHome);
    }

    expect(requests).toEqual([]);
  }, 20_000);

  test("bounded default ingest only persists snapshot-supported selected sources", async () => {
    const codexRoot = mkdtempSync(join(tmpdir(), "quasar-cli-codex-"));
    const homeRoot = mkdtempSync(join(tmpdir(), "quasar-cli-home-root-"));
    const piRoot = join(homeRoot, ".pi", "agent", "sessions");
    const quasarHome = mkdtempSync(join(tmpdir(), "quasar-cli-home-"));
    mkdirSync(piRoot, { recursive: true });
    writeMachineIdentity(quasarHome);
    writeCodexFixture(codexRoot, 3);
    writePiFixture(piRoot, 3);
    const previousChunkDelay = process.env.QUASAR_INGEST_CHUNK_DELAY_MS;
    const previousQuasarHome = process.env.QUASAR_HOME;
    const previousHome = process.env.HOME;
    process.env.QUASAR_INGEST_CHUNK_DELAY_MS = "0";
    process.env.QUASAR_HOME = quasarHome;
    process.env.HOME = homeRoot;
    const uploadedProviders: string[] = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs") {
        const record = spec.body as { expectedChunkCount?: number };
        return Effect.succeed({
          importJobId: "job:default-generation",
          status: "running",
          chunkCount: 0,
          expectedChunkCount: record.expectedChunkCount,
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/job-chunks-bulk") {
        const record = spec.body as {
          chunks?: Array<{ batch?: { sessions?: Array<{ provider?: string }> } }>;
        };
        uploadedProviders.push(
          ...(record.chunks ?? []).flatMap((chunk) =>
            chunk.batch?.sessions?.map((session) => session.provider ?? "missing") ?? [],
          ),
        );
        return Effect.succeed({
          importJobId: "job:default-generation",
          enqueuedCount: record.chunks?.length ?? 0,
          results: [],
        });
      }
      if (spec.method === "POST" && spec.path === "/api/ingest/jobs/schedule") {
        return Effect.succeed({ importJobId: "job:default-generation", scheduled: true });
      }
      if (spec.method === "GET" && spec.path === "/api/ingest/jobs") {
        return Effect.succeed({
          job: {
            importJobId: "job:default-generation",
            status: "running",
            uploadedChunkCount: uploadedProviders.length,
            succeededChunkCount: uploadedProviders.length,
            failedChunkCount: 0,
          },
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

    try {
      const result = await Effect.runPromise(
        runIngestEffect(
          JSON.stringify({
            roots: { codex: codexRoot },
            snapshotSources: true,
            maxUploadChunks: 1,
          }),
          requestClient,
        ) as Effect.Effect<unknown, unknown, never>,
      ) as {
        sourceSnapshot?: { copiedProviders?: readonly string[]; persistent?: boolean };
      };

      expect(result.sourceSnapshot?.persistent).toBe(true);
      expect(result.sourceSnapshot?.copiedProviders).toEqual(["codex"]);
      expect(uploadedProviders).not.toContain("pi");
    } finally {
      restoreEnv("QUASAR_INGEST_CHUNK_DELAY_MS", previousChunkDelay);
      restoreEnv("QUASAR_HOME", previousQuasarHome);
      restoreEnv("HOME", previousHome);
    }
  }, 20_000);

  test("rejects durable ingest generation for providers without snapshot support", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cli-pi-"));
    const quasarHome = mkdtempSync(join(tmpdir(), "quasar-cli-home-"));
    writeMachineIdentity(quasarHome);
    writePiFixture(root, 3);
    const previousQuasarHome = process.env.QUASAR_HOME;
    process.env.QUASAR_HOME = quasarHome;
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const requestClient = ((spec: { method: string; path: string; body?: unknown }) => {
      requests.push({ method: spec.method, path: spec.path, body: spec.body });
      return Effect.fail(new Error(`Unexpected request ${spec.method} ${spec.path}`));
    }) as NonNullable<Parameters<typeof runIngestEffect>[1]>;

    try {
      await expect(
        Effect.runPromise(
          runIngestEffect(
            JSON.stringify({
              providers: ["pi"],
              roots: { pi: root },
              snapshotSources: true,
              maxUploadChunks: 1,
            }),
            requestClient,
          ) as Effect.Effect<unknown, unknown, never>,
        ),
      ).rejects.toThrow(/unsupported provider\(s\): pi/);
    } finally {
      restoreEnv("QUASAR_HOME", previousQuasarHome);
    }

    expect(requests).toEqual([]);
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

const writeCodexFixture = (root: string, count: number) => {
  const sessionDir = join(root, "sessions", "2026", "06", "09");
  mkdirSync(sessionDir, { recursive: true });
  writeJsonl(
    join(sessionDir, "rollout-2026-06-09T00-00-00-test.jsonl"),
    [
      {
        type: "session_meta",
        timestamp: "2026-06-09T00:00:00.000Z",
        payload: { cwd: "/Users/a/Projects/quasar" },
      },
      ...Array.from({ length: count }, (_, index) => ({
        type: "response_item",
        timestamp: `2026-06-09T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
        payload: {
          type: "message",
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message ${index}`,
        },
      })),
    ],
  );
};

const writeCodexSessionFile = (root: string, suffix: string, content: string) => {
  const sessionDir = join(root, "sessions", "2026", "06", "09");
  mkdirSync(sessionDir, { recursive: true });
  writeJsonl(join(sessionDir, `rollout-2026-06-09T00-00-00-${suffix}.jsonl`), [
    {
      type: "session_meta",
      timestamp: "2026-06-09T00:00:00.000Z",
      payload: { cwd: "/Users/a/Projects/quasar" },
    },
    {
      type: "response_item",
      timestamp: "2026-06-09T00:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content,
      },
    },
  ]);
};

const writeMachineIdentity = (quasarHome: string, machine = testMachine) => {
  mkdirSync(quasarHome, { recursive: true });
  writeFileSync(join(quasarHome, "machine.json"), JSON.stringify(machine));
};

const sqliteJson = <A>(dbPath: string, query: string): A[] => {
  const output = execFileSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8" });
  return output.trim().length === 0 ? [] : JSON.parse(output) as A[];
};

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
