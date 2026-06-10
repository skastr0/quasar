import { readFileSync } from "node:fs";

import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
  artifactIdFor,
  buildSession,
  edgeIdFor,
  eventIdFor,
  usageIdFor,
} from "../src/adapters/common";
import { QuasarApiPaths } from "../src/api-paths";
import {
  RECORD_LIMITS,
  RECORD_PROTOCOL,
  clampOversizedRecord,
  decodeRecordEnvelope,
  packRecordEnvelopes,
  recordContentHash,
  recordId,
  recordWireBytes,
  sessionToRecords,
  type IngestRecord,
  type RecordEnvelope,
} from "../src/records";

const machine = {
  machineId: "machine:test",
  hostname: "test-host",
};

const sourcePath = "/fixtures/codex/session-a.jsonl";

const makeSession = () => {
  const firstEventId = eventIdFor("codex", machine.machineId, sourcePath, 0, "first");
  const secondEventId = eventIdFor("codex", machine.machineId, sourcePath, 1, "second");
  return buildSession({
    provider: "codex",
    agentName: "codex",
    machine,
    nativeSessionId: "session-a",
    sourceRoot: "/fixtures/codex",
    sourcePath,
    projectPath: "/work/quasar",
    title: "Contract fixture",
    startedAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:01:00.000Z",
    events: [
      {
        id: firstEventId,
        sequence: 0,
        timestamp: "2026-06-10T00:00:00.000Z",
        role: "user",
        kind: "message",
        contentText: "Please inspect the session.",
        rawReference: { sourcePath, line: 1 },
      },
      {
        id: secondEventId,
        sequence: 1,
        timestamp: "2026-06-10T00:00:05.000Z",
        role: "assistant",
        kind: "tool_call",
        toolCallId: "tool-a",
        contentText: "Checking now.",
        rawReference: { sourcePath, line: 2 },
      },
    ],
    toolCalls: [
      {
        id: "tool-a",
        eventId: secondEventId,
        toolName: "shell",
        input: { command: "date" },
        output: { exitCode: 0, stdout: "Wed Jun 10" },
      },
    ],
    usageRecords: [
      {
        id: usageIdFor("codex", machine.machineId, sourcePath, "session-a", secondEventId, 0),
        eventId: secondEventId,
        inputTokens: 10,
        outputTokens: 12,
        totalTokens: 22,
      },
    ],
    sessionEdges: [
      {
        id: edgeIdFor("codex", machine.machineId, sourcePath, "parent", "parent-a", "session-a"),
        kind: "parent",
        fromId: "parent-a",
        toId: "session-a",
      },
    ],
    artifacts: [
      {
        id: artifactIdFor("codex", machine.machineId, sourcePath, "session-a", "artifact-a"),
        kind: "file",
        path: "/tmp/output.txt",
      },
    ],
  });
};

const envelopeBytes = (envelope: RecordEnvelope) =>
  new TextEncoder().encode(JSON.stringify(envelope)).byteLength;

describe("ingest records", () => {
  test("emits deterministic records and hashes", () => {
    const first = sessionToRecords(makeSession());
    const second = sessionToRecords(makeSession());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((record) => recordContentHash(record))).toEqual(
      second.map((record) => recordContentHash(record)),
    );
  });

  test("places the session record before its children", () => {
    const records = sessionToRecords(makeSession());

    expect(records[0]?.type).toBe("session");
    expect(records.slice(1).map((record) => record.type)).toEqual([
      "event",
      "event",
      "tool_call",
      "usage",
      "edge",
      "artifact",
    ]);
    expect(records[0]?.record).not.toHaveProperty("events");
    expect(records[0]?.record).toMatchObject({
      eventCount: 2,
      toolCallCount: 1,
      contentBlockCount: 0,
      sessionEdgeCount: 1,
      usageRecordCount: 1,
      artifactCount: 1,
    });
  });

  test("preserves content blocks that add information beyond event text", () => {
    const eventId = eventIdFor("codex", machine.machineId, sourcePath, 0, "structured");
    const session = buildSession({
      provider: "codex",
      agentName: "codex",
      machine,
      nativeSessionId: "structured-session",
      sourceRoot: "/fixtures/codex",
      sourcePath,
      projectPath: "/work/quasar",
      events: [
        {
          id: eventId,
          sequence: 0,
          role: "assistant",
          kind: "message",
          contentText: "Assistant summary",
          contentSource: { type: "markdown", markdown: "## Full answer" },
          rawReference: { sourcePath, line: 1 },
        },
      ],
    });

    const records = sessionToRecords(session);
    const contentBlockRecords = records.filter((record) => record.type === "content_block");

    expect(contentBlockRecords).toHaveLength(1);
    expect(contentBlockRecords[0]).toMatchObject({
      type: "content_block",
      record: {
        eventId,
        kind: "markdown",
        markdown: "## Full answer",
      },
    });
    expect(records[0]?.record).toMatchObject({ contentBlockCount: 1 });
  });

  test("preserves structured and metadata-bearing blocks with matching event text", () => {
    const firstEventId = eventIdFor("codex", machine.machineId, sourcePath, 0, "sidecar");
    const secondEventId = eventIdFor("codex", machine.machineId, sourcePath, 1, "markdown");
    const thirdEventId = eventIdFor("codex", machine.machineId, sourcePath, 2, "metadata");
    const session = buildSession({
      provider: "codex",
      agentName: "codex",
      machine,
      nativeSessionId: "sidecar-session",
      sourceRoot: "/fixtures/codex",
      sourcePath,
      projectPath: "/work/quasar",
      events: [
        {
          id: firstEventId,
          sequence: 0,
          role: "assistant",
          kind: "message",
          contentText: "caption",
          contentSource: { type: "image", text: "caption", image_url: "https://example.test/image.png" },
          rawReference: { sourcePath, line: 1 },
        },
        {
          id: secondEventId,
          sequence: 1,
          role: "assistant",
          kind: "message",
          contentText: "## Same",
          contentBlocks: [
            {
              id: "block:markdown",
              sequence: 0,
              kind: "markdown",
              markdown: "## Same",
            },
          ],
          rawReference: { sourcePath, line: 2 },
        },
        {
          id: thirdEventId,
          sequence: 2,
          role: "assistant",
          kind: "message",
          contentText: "same text",
          contentBlocks: [
            {
              id: "block:metadata",
              sequence: 0,
              kind: "text",
              text: "same text",
              metadata: { nativeType: "message" },
            },
          ],
          rawReference: { sourcePath, line: 3 },
        },
      ],
    });

    const records = sessionToRecords(session);
    const contentBlockRecords = records.filter((record) => record.type === "content_block");

    expect(contentBlockRecords).toHaveLength(4);
    expect(contentBlockRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "content_block",
          record: expect.objectContaining({ eventId: firstEventId, kind: "image" }),
        }),
        expect.objectContaining({
          type: "content_block",
          record: expect.objectContaining({ eventId: firstEventId, kind: "text", text: "caption" }),
        }),
        expect.objectContaining({
          type: "content_block",
          record: expect.objectContaining({ eventId: secondEventId, kind: "markdown" }),
        }),
        expect.objectContaining({
          type: "content_block",
          record: expect.objectContaining({
            eventId: thirdEventId,
            kind: "text",
            metadata: { nativeType: "message" },
          }),
        }),
      ]),
    );
  });

  test("suppresses explicit plain duplicate text blocks", () => {
    const eventId = eventIdFor("codex", machine.machineId, sourcePath, 0, "plain-duplicate");
    const session = buildSession({
      provider: "codex",
      agentName: "codex",
      machine,
      nativeSessionId: "plain-duplicate-session",
      sourceRoot: "/fixtures/codex",
      sourcePath,
      projectPath: "/work/quasar",
      events: [
        {
          id: eventId,
          sequence: 0,
          role: "user",
          kind: "message",
          contentText: "same text",
          contentBlocks: [
            {
              id: "block:plain-duplicate",
              sequence: 0,
              kind: "text",
              text: "same text",
            },
          ],
          rawReference: { sourcePath, line: 1 },
        },
      ],
    });

    expect(sessionToRecords(session).map((record) => record.type)).toEqual([
      "session",
      "event",
    ]);
  });

  test("preserves non-derivable session edges", () => {
    const callEventId = eventIdFor("codex", machine.machineId, sourcePath, 0, "call");
    const resultEventId = eventIdFor("codex", machine.machineId, sourcePath, 1, "result");
    const session = buildSession({
      provider: "codex",
      agentName: "codex",
      machine,
      nativeSessionId: "edge-session",
      sourceRoot: "/fixtures/codex",
      sourcePath,
      projectPath: "/work/quasar",
      events: [
        {
          id: callEventId,
          sequence: 0,
          role: "assistant",
          kind: "tool_call",
          toolCallId: "tool-a",
          rawReference: { sourcePath, line: 1 },
        },
        {
          id: resultEventId,
          sequence: 1,
          role: "tool",
          kind: "tool_result",
          toolCallId: "tool-a",
          rawReference: { sourcePath, line: 2 },
        },
      ],
      sessionEdges: [
        {
          id: edgeIdFor("codex", machine.machineId, sourcePath, "parent", "parent-a", "edge-session"),
          kind: "parent",
          fromId: "parent-a",
          toId: "edge-session",
        },
        {
          id: edgeIdFor("codex", machine.machineId, sourcePath, "subagent_of", "agent-a", "edge-session"),
          kind: "subagent_of",
          fromId: "agent-a",
          toId: "edge-session",
        },
        {
          id: edgeIdFor("codex", machine.machineId, sourcePath, "forked_from", "fork-a", "edge-session"),
          kind: "forked_from",
          fromId: "fork-a",
          toId: "edge-session",
        },
        {
          id: edgeIdFor("codex", machine.machineId, sourcePath, "compacted_into", "old-a", "new-a"),
          kind: "compacted_into",
          fromEventId: "old-a",
          toEventId: "new-a",
        },
      ],
    });

    const edgeKinds = sessionToRecords(session)
      .filter((record) => record.type === "edge")
      .map((record) => record.record.kind)
      .sort();

    expect(edgeKinds).toEqual([
      "compacted_into",
      "forked_from",
      "parent",
      "subagent_of",
      "tool_result_for",
    ]);
  });

  test("clamps oversized record payloads deterministically before hashing", () => {
    const record = sessionToRecords(makeSession()).find(
      (candidate) => candidate.type === "tool_call",
    );
    expect(record).toBeDefined();
    const oversized = {
      ...record,
      record: {
        ...record!.record,
        input: { payload: "x".repeat(RECORD_LIMITS.maxRecordBytes) },
      },
    } as IngestRecord;

    const clamped = clampOversizedRecord(oversized);
    expect(clamped).toEqual(clampOversizedRecord(clamped));
    expect(recordWireBytes(clamped)).toBeLessThan(recordWireBytes(oversized));
    expect(recordContentHash(oversized)).toBe(recordContentHash(clamped));
    expect(clamped).toMatchObject({
      type: "tool_call",
      record: {
        input: {
          truncated: true,
          bytes: expect.any(Number),
        },
      },
    });
  });

  test("hashes the same normalized record that packing sends", async () => {
    const record = sessionToRecords(makeSession()).find(
      (candidate) => candidate.type === "tool_call",
    );
    expect(record).toBeDefined();
    const limits = {
      maxRecordBytes: 512,
      maxEnvelopeBytes: 4_096,
      maxRecordsPerEnvelope: 10,
    };
    const oversized = {
      ...record,
      record: {
        ...record!.record,
        input: { payload: "x".repeat(2_000) },
      },
    } as IngestRecord;

    const [envelope] = await Effect.runPromise(
      packRecordEnvelopes({ machine, records: [oversized], limits }),
    );
    const packed = envelope!.records[0]!;

    expect(recordContentHash(oversized, limits)).toBe(recordContentHash(packed, limits));
    expect(recordWireBytes(packed)).toBeLessThanOrEqual(limits.maxRecordBytes);
  });

  test("clamps oversized event text deterministically before hashing", async () => {
    const record = sessionToRecords(makeSession()).find(
      (candidate): candidate is Extract<IngestRecord, { type: "event" }> =>
        candidate.type === "event",
    );
    expect(record).toBeDefined();
    const limits = {
      maxRecordBytes: 1_024,
      maxEnvelopeBytes: 4_096,
      maxRecordsPerEnvelope: 10,
    };
    const oversized = {
      ...record!,
      record: {
        ...record!.record,
        contentText: "event text ".repeat(1_000),
      },
    } as IngestRecord;

    const clamped = clampOversizedRecord(oversized, limits);
    expect(clamped).toEqual(clampOversizedRecord(clamped, limits));
    expect(recordWireBytes(clamped)).toBeLessThanOrEqual(limits.maxRecordBytes);
    expect(recordContentHash(oversized, limits)).toBe(recordContentHash(clamped, limits));
    expect(clamped).toMatchObject({
      type: "event",
      record: {
        contentText: expect.stringContaining("[truncated bytes="),
      },
    });

    const [envelope] = await Effect.runPromise(
      packRecordEnvelopes({ machine, records: [oversized], limits }),
    );
    expect(envelope!.records[0]).toEqual(clamped);
  });

  test("clamps oversized content block text fields as strings", () => {
    const limits = {
      maxRecordBytes: 1_536,
      maxEnvelopeBytes: 4_096,
      maxRecordsPerEnvelope: 10,
    };
    const oversized = {
      type: "content_block",
      record: {
        id: "content-block-large",
        eventId: "event-large",
        sessionId: "session-large",
        machineId: machine.machineId,
        provider: "codex",
        agentName: "codex",
        projectIdentityKey: "project:test",
        sequence: 0,
        kind: "text",
        text: "plain text ".repeat(1_000),
        markdown: "markdown text ".repeat(1_000),
        thinking: "thinking text ".repeat(1_000),
      },
    } as IngestRecord;

    const clamped = clampOversizedRecord(oversized, limits);

    expect(clamped).toEqual(clampOversizedRecord(clamped, limits));
    expect(recordWireBytes(clamped)).toBeLessThanOrEqual(limits.maxRecordBytes);
    expect(clamped.type).toBe("content_block");
    const contentBlock = clamped.type === "content_block" ? clamped.record : undefined;
    expect(contentBlock).toBeDefined();
    expect(typeof contentBlock?.text).toBe("string");
    expect(typeof contentBlock?.markdown).toBe("string");
    expect(typeof contentBlock?.thinking).toBe("string");
    expect(contentBlock?.text).toContain("[truncated bytes=");
    expect(contentBlock?.markdown).toContain("[truncated bytes=");
    expect(contentBlock?.thinking).toContain("[truncated bytes=");
  });

  test("packs envelopes within protocol limits", async () => {
    const records = Array.from({ length: RECORD_LIMITS.maxRecordsPerEnvelope + 5 }, (_, index) => ({
      type: "source_root" as const,
      record: {
        provider: "codex" as const,
        adapterId: `codex-${index}`,
        rootPath: `/fixtures/codex/${index}`,
        machineId: machine.machineId,
        discoveredAt: "2026-06-10T00:00:00.000Z",
      },
    }));

    const envelopes = await Effect.runPromise(packRecordEnvelopes({ machine, records }));
    expect(envelopes.length).toBeGreaterThan(1);
    expect(envelopes.flatMap((envelope) => envelope.records).map(recordId)).toEqual(
      records.map(recordId),
    );
    for (const envelope of envelopes) {
      expect(envelope.protocol).toBe(RECORD_PROTOCOL);
      expect(envelope.records.length).toBeLessThanOrEqual(RECORD_LIMITS.maxRecordsPerEnvelope);
      expect(envelopeBytes(envelope)).toBeLessThanOrEqual(RECORD_LIMITS.maxEnvelopeBytes);
      for (const record of envelope.records) {
        expect(recordWireBytes(record)).toBeLessThanOrEqual(RECORD_LIMITS.maxRecordBytes);
      }
    }
  });

  test("splits envelopes by byte cap", async () => {
    const limits = {
      maxRecordBytes: 2_048,
      maxEnvelopeBytes: 700,
      maxRecordsPerEnvelope: 100,
    };
    const records = Array.from({ length: 10 }, (_, index) => ({
      type: "source_root" as const,
      record: {
        provider: "codex" as const,
        adapterId: `codex-${index}`,
        rootPath: `/fixtures/codex/${"x".repeat(120)}-${index}`,
        machineId: machine.machineId,
        discoveredAt: "2026-06-10T00:00:00.000Z",
      },
    }));

    const envelopes = await Effect.runPromise(
      packRecordEnvelopes({ machine, records, limits }),
    );

    expect(envelopes.length).toBeGreaterThan(1);
    for (const envelope of envelopes) {
      expect(envelope.records.length).toBeLessThan(limits.maxRecordsPerEnvelope);
      expect(envelopeBytes(envelope)).toBeLessThanOrEqual(limits.maxEnvelopeBytes);
    }
  });

  test("fails typed when one normalized record cannot fit an envelope", async () => {
    const record = sessionToRecords(makeSession()).find(
      (candidate) => candidate.type === "tool_call",
    );
    expect(record).toBeDefined();
    const oversized = {
      ...record,
      record: {
        ...record!.record,
        input: { payload: "x".repeat(2_000) },
      },
    } as IngestRecord;
    const error = await Effect.runPromise(
      Effect.flip(
        packRecordEnvelopes({
          machine,
          records: [oversized],
          limits: {
            maxRecordBytes: 1_024,
            maxEnvelopeBytes: 120,
            maxRecordsPerEnvelope: 10,
          },
        }),
      ),
    );

    expect(error._tag).toBe("RecordContractError");
    expect(error.reason).toBe("envelope_too_large");
  });

  test("publishes the ingest records API path", () => {
    expect(QuasarApiPaths.ingestRecords).toBe("/api/ingest/records");
  });

  test("fails closed on invalid envelope protocol", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decodeRecordEnvelope({
          protocol: "quasar-records/v0",
          machine,
          records: [],
        }),
      ),
    );

    expect(error._tag).toBe("RecordContractError");
    expect(error.reason).toBe("invalid_envelope");
  });

  test("fails typed on non JSON payloads", async () => {
    const record = sessionToRecords(makeSession()).find(
      (candidate) => candidate.type === "tool_call",
    );
    expect(record).toBeDefined();
    const invalid = {
      ...record,
      record: {
        ...record!.record,
        input: { count: 1n },
      },
    } as IngestRecord;
    const error = await Effect.runPromise(
      Effect.flip(packRecordEnvelopes({ machine, records: [invalid] })),
    );

    expect(error._tag).toBe("RecordContractError");
    expect(error.reason).toBe("invalid_envelope");
  });

  test("does not clamp typed project identity values", async () => {
    const record = sessionToRecords(makeSession()).find(
      (candidate): candidate is Extract<IngestRecord, { type: "session" }> =>
        candidate.type === "session",
    );
    expect(record).toBeDefined();
    const oversized = {
      ...record,
      record: {
        ...record!.record,
        projectIdentity: {
          ...record!.record.projectIdentity,
          signals: [
            {
              kind: "path",
              value: "x".repeat(1_000),
              confidence: "low",
            },
          ],
        },
      },
    } as IngestRecord;
    const error = await Effect.runPromise(
      Effect.flip(
        decodeRecordEnvelope(
          {
            protocol: RECORD_PROTOCOL,
            machine,
            records: [oversized],
          },
          {
            maxRecordBytes: 256,
            maxEnvelopeBytes: 4_096,
            maxRecordsPerEnvelope: 10,
          },
        ),
      ),
    );

    expect(error._tag).toBe("RecordContractError");
    expect(error.reason).toBe("record_too_large");
  });

  test("keeps deleted terminology out of the contract and test source", () => {
    const token = (...chars: readonly number[]) => String.fromCharCode(...chars);
    const deletedTerms = [
      token(114, 111, 119),
      `${token(114, 111, 119)}Stream`,
      `${token(114, 111, 119)}_stream`,
      `Ingest${token(82, 111, 119)}`,
      `import${token(74, 111, 98)}`,
      token(99, 104, 117, 110, 107),
      token(103, 101, 110, 101, 114, 97, 116, 105, 111, 110),
      `${token(98, 97, 99, 107)}fill`,
    ];
    const files = [
      readFileSync(new URL("../src/records.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./records.test.ts", import.meta.url), "utf8"),
    ];

    for (const file of files) {
      for (const deletedTerm of deletedTerms) {
        expect(file).not.toContain(deletedTerm);
      }
    }
  });
});
