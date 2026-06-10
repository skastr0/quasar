import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  packRecordEnvelopes,
  RECORD_LIMITS,
  RECORD_PROTOCOL,
  type IngestRecord,
  type MachineIdentity,
  type RecordEnvelope,
  type RecordStreamOptions,
  type SessionAdapter,
  type SourceRoot,
  type SourceUnit,
  type UnitFingerprint,
} from "@skastr0/quasar-core";

import { runIngest } from "../src/ingest/runner";
import type { RecordEnvelopeSender } from "../src/ingest/sender";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E, never>);

let tempDir: string | undefined;

const machine: MachineIdentity = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "test",
};

const root: SourceRoot = {
  provider: "codex",
  adapterId: "codex-test-records",
  rootPath: "/logical/codex/sessions",
  machineId: machine.machineId,
  discoveredAt: "2026-06-10T00:00:00.000Z",
};

const unitFingerprint: UnitFingerprint = { size: 1_024, mtimeMs: 1_000 };

const makeUnit = (sourcePath: string, physicalPath: string): SourceUnit => ({
  provider: "codex",
  adapterId: root.adapterId,
  rootPath: root.rootPath,
  sourcePath,
  physicalPath,
});

const eventRecord = (id: string, sourcePath: string, text = "hello"): IngestRecord => ({
  type: "event",
  record: {
    id,
    sessionId: `session:${id}`,
    sequence: 0,
    machineId: machine.machineId,
    provider: "codex",
    agentName: "codex",
    projectIdentityKey: "project:test",
    role: "user",
    kind: "message",
    contentText: text,
    rawReference: { sourcePath },
  },
});

const contentBlockRecord = (id: string, value: unknown): IngestRecord => ({
  type: "content_block",
  record: {
    id,
    eventId: `event:${id}`,
    sessionId: `session:${id}`,
    machineId: machine.machineId,
    provider: "codex",
    agentName: "codex",
    projectIdentityKey: "project:test",
    sequence: 0,
    kind: "json",
    text: `useful ${id}`,
    value,
  },
});

const shouldProcess = async (
  options: RecordStreamOptions,
  unit: SourceUnit,
  fingerprint: UnitFingerprint,
) => options.shouldProcessUnit?.(unit, fingerprint) ?? true;

type StreamMode = "present" | "missing-incomplete" | "missing-complete";

const makeAdapter = (
  unit: SourceUnit,
  record: IngestRecord,
  mode: () => StreamMode,
): SessionAdapter => ({
  id: root.adapterId,
  provider: "codex",
  displayName: "Codex test records",
  stable: true,
  defaultRoot: () => root.rootPath,
  read: async () => ({ sourceRoots: [], sessions: [], diagnostics: [] }),
  streamRecords: async function* (options) {
    yield { type: "record" as const, item: { type: "source_root" as const, record: root } };
    const currentMode = mode();
    if (currentMode === "present") {
      yield { type: "unitStart" as const, unit, fingerprint: unitFingerprint };
      if (await shouldProcess(options, unit, unitFingerprint)) {
        yield { type: "record" as const, item: record };
      }
      yield { type: "unitEnd" as const, unit, complete: true };
    }
    yield {
      type: "rootScanned" as const,
      root,
      complete: currentMode === "missing-complete" || currentMode === "present",
    };
  },
});

const responseFor = (envelope: RecordEnvelope) => ({
  protocol: RECORD_PROTOCOL,
  applied: envelope.records.filter((record) => record.type !== "tombstone").length,
  unchanged: 0,
  tombstoned: envelope.records.filter((record) => record.type === "tombstone").length,
  backpressure: {
    outboxDepth: 0,
    retryAfterMs: null,
  },
  limits: RECORD_LIMITS,
});

const makeSender = (options: {
  readonly failOnSend?: number;
  readonly responseForEnvelope?: (envelope: RecordEnvelope) => ReturnType<typeof responseFor>;
} = {}) => {
  const envelopes: RecordEnvelope[] = [];
  let sendCount = 0;
  const sender: RecordEnvelopeSender<Error> = {
    send: (envelope) =>
      Effect.try({
        try: () => {
          sendCount += 1;
          if (sendCount === options.failOnSend) {
            throw new Error("simulated interrupted send");
          }
          envelopes.push(envelope);
          return options.responseForEnvelope?.(envelope) ?? responseFor(envelope);
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
  };
  return { sender, envelopes };
};

const openTempDir = async () => {
  tempDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "quasar-ingest-runner-"));
  return tempDir;
};

describe("ingest runner", () => {
  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("converges after an interrupted send and skips acked stable units", async () => {
    const dir = await openTempDir();
    const physicalPath = join(dir, "session-a.jsonl");
    await writeFile(physicalPath, "{}\n");
    const sourcePath = `${root.rootPath}/session-a.jsonl`;
    const unit = makeUnit(sourcePath, physicalPath);
    const adapter = makeAdapter(unit, eventRecord("event:a", sourcePath), () => "present");
    const ledgerPath = join(dir, "ledger.sqlite");

    const firstSender = makeSender({ failOnSend: 2 });
    await expect(
      run(
        runIngest(
          { providers: ["codex"], dryRun: false },
          { adapters: [adapter], ledgerPath, machine, sender: firstSender.sender },
        ),
      ),
    ).rejects.toThrow("simulated interrupted send");

    const secondSender = makeSender();
    const second = await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [adapter], ledgerPath, machine, sender: secondSender.sender },
      ),
    );
    expect(second.records.sent).toBe(1);
    expect(secondSender.envelopes.flatMap((envelope) => envelope.records).map((record) => record.type)).toEqual([
      "event",
    ]);

    const thirdSender = makeSender();
    const third = await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [adapter], ledgerPath, machine, sender: thirdSender.sender },
      ),
    );
    expect(third.files.skipped).toBe(1);
    expect(third.records.sent).toBe(0);
    expect(thirdSender.envelopes).toEqual([]);
  });

  test("fails before acking when response counts do not cover the envelope", async () => {
    const dir = await openTempDir();
    const physicalPath = join(dir, "session-counts.jsonl");
    await writeFile(physicalPath, "{}\n");
    const sourcePath = `${root.rootPath}/session-counts.jsonl`;
    const unit = makeUnit(sourcePath, physicalPath);
    const adapter = makeAdapter(unit, eventRecord("event:counts", sourcePath), () => "present");
    const ledgerPath = join(dir, "ledger.sqlite");
    const mismatchedSender = makeSender({
      responseForEnvelope: (envelope) =>
        envelope.records.some((record) => record.type === "event")
          ? {
              ...responseFor(envelope),
              applied: 0,
              unchanged: 0,
              tombstoned: 0,
            }
          : responseFor(envelope),
    });

    const error = await run(
      Effect.flip(
        runIngest(
          { providers: ["codex"], dryRun: false },
          { adapters: [adapter], ledgerPath, machine, sender: mismatchedSender.sender },
        ),
      ),
    );
    expect(error).toMatchObject({
      _tag: "IngestRunError",
      reason: "response_count_mismatch",
    });

    const secondSender = makeSender();
    const second = await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [adapter], ledgerPath, machine, sender: secondSender.sender },
      ),
    );
    expect(second.records.sent).toBe(1);
    expect(secondSender.envelopes.flatMap((envelope) => envelope.records).map((record) => record.type)).toEqual([
      "event",
    ]);
  });

  test("dry-run fails loudly for structurally invalid adapter records", async () => {
    const dir = await openTempDir();
    const physicalPath = join(dir, "session-invalid.jsonl");
    await writeFile(physicalPath, "{}\n");
    const sourcePath = `${root.rootPath}/session-invalid.jsonl`;
    const unit = makeUnit(sourcePath, physicalPath);
    const invalid = {
      type: "event",
      record: {
        id: "event:invalid",
        sessionId: "session:invalid",
        sequence: 0,
        machineId: machine.machineId,
        provider: "codex",
        agentName: "codex",
        projectIdentityKey: "project:test",
        role: "user",
        kind: "message",
        contentText: "invalid event",
      },
    } as unknown as IngestRecord;
    const adapter = makeAdapter(unit, invalid, () => "present");

    const error = await run(
      Effect.flip(
        runIngest(
          { providers: ["codex"], dryRun: true },
          { adapters: [adapter], machine },
        ),
      ),
    );
    expect(error).toMatchObject({
      _tag: "IngestRunError",
      reason: "invalid_record_envelope",
    });
  });

  test("defaults to dry-run when dryRun is omitted", async () => {
    const dir = await openTempDir();
    const physicalPath = join(dir, "session-default.jsonl");
    await writeFile(physicalPath, "{}\n");
    const sourcePath = `${root.rootPath}/session-default.jsonl`;
    const unit = makeUnit(sourcePath, physicalPath);
    const adapter = makeAdapter(unit, eventRecord("event:default", sourcePath), () => "present");

    const report = await run(runIngest({ providers: ["codex"] }, { adapters: [adapter], machine }));
    expect(report.dryRun).toBe(true);
    expect(report.records.sent).toBe(2);
  });

  test("emits tombstones only after complete scans and filesystem-confirmed removals", async () => {
    const dir = await openTempDir();
    const physicalPath = join(dir, "session-b.jsonl");
    await writeFile(physicalPath, "{}\n");
    const sourcePath = `${root.rootPath}/session-b.jsonl`;
    const unit = makeUnit(sourcePath, physicalPath);
    let mode: StreamMode = "present";
    const adapter = makeAdapter(unit, eventRecord("event:b", sourcePath), () => mode);
    const ledgerPath = join(dir, "ledger.sqlite");

    await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [adapter], ledgerPath, machine, sender: makeSender().sender },
      ),
    );
    await unlink(physicalPath);

    mode = "missing-incomplete";
    const incompleteSender = makeSender();
    const incomplete = await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [adapter], ledgerPath, machine, sender: incompleteSender.sender },
      ),
    );
    expect(incomplete.records.tombstoned).toBe(0);
    expect(
      incompleteSender.envelopes
        .flatMap((envelope) => envelope.records)
        .filter((record) => record.type === "tombstone"),
    ).toEqual([]);

    mode = "missing-complete";
    const completeSender = makeSender();
    const complete = await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [adapter], ledgerPath, machine, sender: completeSender.sender },
      ),
    );
    expect(complete.files.removed).toBe(1);
    expect(complete.records.tombstoned).toBe(1);
    expect(completeSender.envelopes.flatMap((envelope) => envelope.records)).toEqual([
      { type: "tombstone", record: { recordType: "event", recordId: "event:b" } },
    ]);
  });

  test("accepts unchanged tombstone acknowledgments for idempotent resume", async () => {
    const dir = await openTempDir();
    const physicalPath = join(dir, "session-tombstone-resume.jsonl");
    await writeFile(physicalPath, "{}\n");
    const sourcePath = `${root.rootPath}/session-tombstone-resume.jsonl`;
    const unit = makeUnit(sourcePath, physicalPath);
    let mode: StreamMode = "present";
    const adapter = makeAdapter(unit, eventRecord("event:tombstone-resume", sourcePath), () => mode);
    const ledgerPath = join(dir, "ledger.sqlite");

    await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [adapter], ledgerPath, machine, sender: makeSender().sender },
      ),
    );
    await unlink(physicalPath);
    mode = "missing-complete";

    const sender = makeSender({
      responseForEnvelope: (envelope) =>
        envelope.records.some((record) => record.type === "tombstone")
          ? {
              ...responseFor(envelope),
              applied: 0,
              unchanged: envelope.records.length,
              tombstoned: 0,
            }
          : responseFor(envelope),
    });
    const report = await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [adapter], ledgerPath, machine, sender: sender.sender },
      ),
    );

    expect(report.envelopes.serverUnchanged).toBe(1);
    expect(report.records.tombstoned).toBe(1);

    const thirdSender = makeSender();
    const third = await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [adapter], ledgerPath, machine, sender: thirdSender.sender },
      ),
    );
    expect(third.records.tombstoned).toBe(0);
    expect(
      thirdSender.envelopes
        .flatMap((envelope) => envelope.records)
        .filter((record) => record.type === "tombstone"),
    ).toEqual([]);
  });

  test("suppresses missing-file tombstones after fatal adapter diagnostics", async () => {
    const dir = await openTempDir();
    const physicalPath = join(dir, "session-diagnostic.jsonl");
    await writeFile(physicalPath, "{}\n");
    const sourcePath = `${root.rootPath}/session-diagnostic.jsonl`;
    const unit = makeUnit(sourcePath, physicalPath);
    const ledgerPath = join(dir, "ledger.sqlite");
    const presentAdapter = makeAdapter(unit, eventRecord("event:diagnostic", sourcePath), () => "present");

    await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [presentAdapter], ledgerPath, machine, sender: makeSender().sender },
      ),
    );
    await unlink(physicalPath);

    const diagnosticAdapter: SessionAdapter = {
      ...presentAdapter,
      streamRecords: async function* () {
        yield { type: "record" as const, item: { type: "source_root" as const, record: root } };
        yield {
          type: "diagnostic" as const,
          diagnostic: {
            adapterId: root.adapterId,
            provider: "codex" as const,
            status: "error" as const,
            rootPath: root.rootPath,
            message: "synthetic adapter failure",
          },
        };
        yield { type: "rootScanned" as const, root, complete: true };
      },
    };
    const sender = makeSender();
    const report = await run(
      runIngest(
        { providers: ["codex"], dryRun: false },
        { adapters: [diagnosticAdapter], ledgerPath, machine, sender: sender.sender },
      ),
    );

    expect(report.records.tombstoned).toBe(0);
    expect(sender.envelopes.flatMap((envelope) => envelope.records).filter((record) => record.type === "tombstone")).toEqual([]);
  });

  test("closes adapter streams when downstream send fails", async () => {
    const dir = await openTempDir();
    const physicalPath = join(dir, "session-close.jsonl");
    await writeFile(physicalPath, "{}\n");
    const sourcePath = `${root.rootPath}/session-close.jsonl`;
    const unit = makeUnit(sourcePath, physicalPath);
    let closed = false;
    const adapter: SessionAdapter = {
      id: root.adapterId,
      provider: "codex",
      displayName: "Codex closing records",
      stable: true,
      defaultRoot: () => root.rootPath,
      read: async () => ({ sourceRoots: [], sessions: [], diagnostics: [] }),
      streamRecords: async function* (options) {
        try {
          yield { type: "record" as const, item: { type: "source_root" as const, record: root } };
          yield { type: "unitStart" as const, unit, fingerprint: unitFingerprint };
          if (await shouldProcess(options, unit, unitFingerprint)) {
            yield { type: "record" as const, item: eventRecord("event:close", sourcePath) };
          }
          yield { type: "unitEnd" as const, unit, complete: true };
          yield { type: "rootScanned" as const, root, complete: true };
        } finally {
          closed = true;
        }
      },
    };

    await expect(
      run(
        runIngest(
          { providers: ["codex"], dryRun: false },
          {
            adapters: [adapter],
            ledgerPath: join(dir, "ledger.sqlite"),
            machine,
            sender: makeSender({ failOnSend: 2 }).sender,
          },
        ),
      ),
    ).rejects.toThrow("simulated interrupted send");
    expect(closed).toBe(true);
  });

  test("shared envelope packing stays within record limits", async () => {
    const records = Array.from({ length: RECORD_LIMITS.maxRecordsPerEnvelope + 10 }, (_, index) =>
      eventRecord(`event:${index}`, `${root.rootPath}/session-${index}.jsonl`, `message ${index}`),
    );

    const envelopes = await run(packRecordEnvelopes({ machine, records }));
    const textEncoder = new TextEncoder();
    for (const envelope of envelopes) {
      expect(envelope.records.length).toBeLessThanOrEqual(RECORD_LIMITS.maxRecordsPerEnvelope);
      expect(textEncoder.encode(JSON.stringify(envelope)).byteLength).toBeLessThanOrEqual(
        RECORD_LIMITS.maxEnvelopeBytes,
      );
    }
  });

  test(
    "[slow] bounded memory dry-run over 200 one-megabyte synthetic records",
    async () => {
      const bigValue = "x".repeat(1024 * 1024);
      const adapter: SessionAdapter = {
        id: root.adapterId,
        provider: "codex",
        displayName: "Codex synthetic records",
        stable: true,
        defaultRoot: () => root.rootPath,
        read: async () => ({ sourceRoots: [], sessions: [], diagnostics: [] }),
        streamRecords: async function* (options) {
          yield { type: "record" as const, item: { type: "source_root" as const, record: root } };
          for (let index = 0; index < 200; index += 1) {
            const sourcePath = `${root.rootPath}/synthetic-${index}.jsonl`;
            const unit = makeUnit(sourcePath, `/synthetic/${index}.jsonl`);
            const fingerprint = { size: 1024 * 1024, mtimeMs: index };
            yield { type: "unitStart" as const, unit, fingerprint };
            if (await shouldProcess(options, unit, fingerprint)) {
              yield { type: "record" as const, item: contentBlockRecord(`block:${index}`, bigValue) };
            }
            yield { type: "unitEnd" as const, unit, complete: true };
          }
          yield { type: "rootScanned" as const, root, complete: true };
        },
      };

      const report = await run(
        runIngest(
          { providers: ["codex"], dryRun: true },
          { adapters: [adapter], machine, rssSampleIntervalMs: 25 },
        ),
      );

      expect(report.records.sent).toBe(201);
      expect(report.records.byType.content_block?.count).toBe(200);
      expect(report.memory.rssHighWaterBytes).toBeLessThan(768 * 1024 * 1024);
    },
    30_000,
  );
});
