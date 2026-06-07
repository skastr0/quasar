import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildIngestBatch, sanitizeIngestBatchForTransport } from "@skastr0/quasar-core";
import { chunkIngestBatch } from "../src/commands/ingest";

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
