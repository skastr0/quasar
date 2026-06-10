import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import {
  RECORD_PROTOCOL,
  type RecordEnvelope,
} from "@skastr0/quasar-core/records";

import schema from "./schema";
import { applyRecordEnvelopeHandler } from "./quasarRecordIngest";
import { readSessionHandler } from "./quasarReadHandlers";
import type { MutationCtx } from "./_generated/server";
import { EMBEDDING_POLICY_VERSION } from "./quasarSearchDocuments";

const machine = {
  machineId: "machine:test",
  hostname: "test-host",
};

const sessionRecord = {
  id: "session:test",
  nativeSessionId: "native:test",
  provider: "codex" as const,
  agentName: "codex",
  machineId: machine.machineId,
  projectIdentity: {
    projectIdentityKey: "project:test",
    displayName: "Test Project",
    confidence: "explicit" as const,
    rawPath: "/tmp/test-project",
    signals: [
      {
        kind: "explicit" as const,
        value: "/tmp/test-project",
        confidence: "explicit" as const,
      },
    ],
  },
  title: "Test Session",
  startedAt: "2026-06-10T12:00:00.000Z",
  updatedAt: "2026-06-10T12:01:00.000Z",
  sourceRoot: "/tmp",
  sourcePath: "/tmp/session.jsonl",
  eventCount: 0,
  toolCallCount: 0,
  contentBlockCount: 0,
  sessionEdgeCount: 0,
  usageRecordCount: 0,
  artifactCount: 0,
};

const projectIdentityKey = sessionRecord.projectIdentity.projectIdentityKey;

const eventRecord = {
  id: "event:test",
  sessionId: sessionRecord.id,
  nativeEventId: "native-event:test",
  sequence: 0,
  timestamp: "2026-06-10T12:00:30.000Z",
  machineId: machine.machineId,
  provider: "codex" as const,
  agentName: "codex",
  projectIdentityKey,
  role: "user" as const,
  kind: "message" as const,
  contentText: "event search text",
  rawReference: { sourcePath: sessionRecord.sourcePath, line: 1 },
};

const contentBlockRecord = {
  id: "block:test",
  eventId: eventRecord.id,
  sessionId: sessionRecord.id,
  sequence: 0,
  machineId: machine.machineId,
  provider: "codex" as const,
  agentName: "codex",
  projectIdentityKey,
  kind: "text" as const,
  text: "content block text",
};

const toolCallRecord = {
  id: "tool:test",
  sessionId: sessionRecord.id,
  eventId: eventRecord.id,
  machineId: machine.machineId,
  provider: "codex" as const,
  agentName: "codex",
  projectIdentityKey,
  toolName: "read_file",
  status: "completed",
  input: { path: "README.md" },
};

const artifactRecord = {
  id: "artifact:test",
  sessionId: sessionRecord.id,
  eventId: eventRecord.id,
  machineId: machine.machineId,
  provider: "codex" as const,
  agentName: "codex",
  projectIdentityKey,
  kind: "file",
  path: "/tmp/artifact.txt",
  contentHash: "hash:test",
};

const envelope = (records: RecordEnvelope["records"]): RecordEnvelope => ({
  protocol: RECORD_PROTOCOL,
  machine,
  records,
});

const apply = async (ctx: MutationCtx, input: unknown) =>
  await applyRecordEnvelopeHandler(ctx, input);

const withGoogleApiKey = async <A>(action: () => Promise<A>) => {
  const previousGoogleApiKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "test-key";
  try {
    return await action();
  } finally {
    if (previousGoogleApiKey === undefined) {
      delete process.env.GOOGLE_API_KEY;
    } else {
      process.env.GOOGLE_API_KEY = previousGoogleApiKey;
    }
  }
};

type ModuleGlob = (pattern: string | readonly string[]) => Record<string, () => Promise<unknown>>;

const modules = (import.meta as ImportMeta & { glob: ModuleGlob }).glob([
  "./**/*.{ts,js}",
  "!./**/*.test.ts",
]);

const testBackend = () => convexTest({ schema, modules });

describe("record envelope ingest", () => {
  test("upserts records idempotently and writes search documents", async () => {
    const t = testBackend();
    const input = envelope([{ type: "session", record: sessionRecord }]);

    const first = await t.mutation(async (ctx) => await apply(ctx as MutationCtx, input));
    expect(first.applied).toBe(1);
    expect(first.unchanged).toBe(0);
    expect(first.tombstoned).toBe(0);
    expect(first.protocol).toBe(RECORD_PROTOCOL);

    const second = await t.mutation(async (ctx) => await apply(ctx as MutationCtx, input));
    expect(second.applied).toBe(0);
    expect(second.unchanged).toBe(1);

    const state = await t.query(async (ctx) => ({
      sessions: await ctx.db.query("sessions").collect(),
      searchDocuments: await ctx.db.query("searchDocuments").collect(),
      recordStates: await ctx.db.query("recordStates").collect(),
    }));
    expect(state.sessions).toHaveLength(1);
    expect(
      state.searchDocuments.some((doc) => doc.searchDocumentId === "session:session:test"),
    ).toBe(true);
    expect(state.recordStates).toHaveLength(1);
    expect(state.recordStates[0]?.tombstoned).toBe(false);
  });

  test("writes search documents only for searchable source records", async () => {
    const t = testBackend();
    await withGoogleApiKey(async () => {
      await t.mutation(async (ctx) =>
        await apply(
          ctx as MutationCtx,
          envelope([
            { type: "session", record: sessionRecord },
            { type: "event", record: eventRecord },
            { type: "content_block", record: contentBlockRecord },
            { type: "tool_call", record: toolCallRecord },
            { type: "artifact", record: artifactRecord },
          ]),
        ),
      );
    });

    const state = await t.query(async (ctx) => ({
      contentBlocks: await ctx.db.query("contentBlocks").collect(),
      artifacts: await ctx.db.query("artifacts").collect(),
      searchDocuments: await ctx.db.query("searchDocuments").collect(),
      embeddingOutbox: await ctx.db.query("embeddingOutbox").collect(),
    }));
    expect(state.contentBlocks).toHaveLength(1);
    expect(state.artifacts).toHaveLength(1);
    expect(
      state.searchDocuments
        .filter((doc) => doc.sourceTable !== "projectIdentities")
        .map((doc) => doc.searchDocumentId)
        .sort(),
    ).toEqual(["event:event:test", "session:session:test", "tool_call:tool:test"]);
    expect(state.embeddingOutbox.map((doc) => doc.searchDocumentId)).toEqual(["event:event:test"]);
  });

  test("synthesizes duplicate text content blocks when reading a session", async () => {
    const t = testBackend();
    await t.mutation(async (ctx) =>
      await apply(
        ctx as MutationCtx,
        envelope([
          { type: "session", record: { ...sessionRecord, eventCount: 1 } },
          { type: "event", record: eventRecord },
        ]),
      ),
    );

    const state = await t.query(async (ctx) => ({
      storedBlocks: await ctx.db.query("contentBlocks").collect(),
      session: await readSessionHandler(ctx, { sessionId: sessionRecord.id }),
    }));

    expect(state.storedBlocks).toHaveLength(0);
    expect(state.session?.contentBlocks).toHaveLength(0);
    expect(state.session?.views.chronological[0]?.contentBlocks).toEqual([
      expect.objectContaining({
        blockId: `${eventRecord.id}:contentText`,
        eventId: eventRecord.id,
        kind: "text",
        text: eventRecord.contentText,
      }),
    ]);
  });

  test("embeds assistant message events under the narrative policy", async () => {
    const t = testBackend();
    const assistantEvent = {
      ...eventRecord,
      id: "event:assistant",
      nativeEventId: "native-event:assistant",
      role: "assistant" as const,
      contentText: "assistant answer text",
    };

    await withGoogleApiKey(async () => {
      await t.mutation(async (ctx) =>
        await apply(
          ctx as MutationCtx,
          envelope([
            { type: "session", record: sessionRecord },
            { type: "event", record: assistantEvent },
          ]),
        ),
      );
    });

    const state = await t.query(async (ctx) => ({
      searchDocuments: await ctx.db.query("searchDocuments").collect(),
      embeddingOutbox: await ctx.db.query("embeddingOutbox").collect(),
    }));
    const assistantDoc = state.searchDocuments.find(
      (doc) => doc.searchDocumentId === "event:event:assistant",
    );
    expect(assistantDoc?.embeddingEligible).toBe(true);
    expect(assistantDoc?.embeddingSkipReason).toBeUndefined();
    expect(assistantDoc?.embeddingPolicyVersion).toBe(EMBEDDING_POLICY_VERSION);
    expect(state.embeddingOutbox.map((doc) => doc.searchDocumentId)).toEqual([
      "event:event:assistant",
    ]);
  });

  test("keeps machinery events out of embedding outbox", async () => {
    const t = testBackend();
    const skippedEvents = [
      {
        ...eventRecord,
        id: "event:reasoning",
        nativeEventId: "native-event:reasoning",
        role: "assistant" as const,
        kind: "reasoning" as const,
        contentText: "reasoning text",
      },
      {
        ...eventRecord,
        id: "event:tool-result",
        nativeEventId: "native-event:tool-result",
        role: "tool" as const,
        kind: "tool_result" as const,
        contentText: "tool result text",
      },
      {
        ...eventRecord,
        id: "event:thinking",
        nativeEventId: "native-event:thinking",
        role: "thinking" as const,
        kind: "message" as const,
        contentText: "thinking text",
      },
    ];

    await withGoogleApiKey(async () => {
      await t.mutation(async (ctx) =>
        await apply(
          ctx as MutationCtx,
          envelope([
            { type: "session", record: sessionRecord },
            ...skippedEvents.map((record) => ({ type: "event" as const, record })),
          ]),
        ),
      );
    });

    const state = await t.query(async (ctx) => ({
      searchDocuments: await ctx.db.query("searchDocuments").collect(),
      embeddingOutbox: await ctx.db.query("embeddingOutbox").collect(),
    }));
    const byId = new Map(state.searchDocuments.map((doc) => [doc.searchDocumentId, doc]));
    expect(byId.get("event:event:reasoning")?.embeddingEligible).toBe(false);
    expect(byId.get("event:event:reasoning")?.embeddingSkipReason).toBe("reasoning");
    expect(byId.get("event:event:tool-result")?.embeddingEligible).toBe(false);
    expect(byId.get("event:event:tool-result")?.embeddingSkipReason).toBe("tool_metadata_only");
    expect(byId.get("event:event:thinking")?.embeddingEligible).toBe(false);
    expect(byId.get("event:event:thinking")?.embeddingSkipReason).toBe("reasoning");
    expect(state.embeddingOutbox).toHaveLength(0);
  });

  test("records tombstones idempotently and removes source search documents", async () => {
    const t = testBackend();
    await t.mutation(async (ctx) =>
      await apply(ctx as MutationCtx, envelope([{ type: "session", record: sessionRecord }])),
    );

    const tombstone = envelope([
      {
        type: "tombstone",
        record: { recordType: "session", recordId: sessionRecord.id },
      },
    ]);
    const first = await t.mutation(async (ctx) => await apply(ctx as MutationCtx, tombstone));
    expect(first.tombstoned).toBe(1);
    expect(first.unchanged).toBe(0);

    const second = await t.mutation(async (ctx) => await apply(ctx as MutationCtx, tombstone));
    expect(second.tombstoned).toBe(0);
    expect(second.unchanged).toBe(1);

    const state = await t.query(async (ctx) => ({
      sessions: await ctx.db.query("sessions").collect(),
      searchDocuments: await ctx.db.query("searchDocuments").collect(),
      tombstones: await ctx.db.query("tombstones").collect(),
      recordStates: await ctx.db.query("recordStates").collect(),
    }));
    expect(state.sessions).toHaveLength(0);
    expect(
      state.searchDocuments.some((doc) => doc.searchDocumentId === "session:session:test"),
    ).toBe(false);
    expect(state.tombstones).toHaveLength(1);
    expect(state.recordStates[0]?.tombstoned).toBe(true);
  });

  test("invalid envelopes leave source tables empty", async () => {
    const t = testBackend();
    const invalid = envelope([
      { type: "session", record: sessionRecord },
      { type: "event", record: { id: "event:invalid" } as never },
    ]);

    await expect(
      t.mutation(async (ctx) => await apply(ctx as MutationCtx, invalid)),
    ).rejects.toThrow();

    const state = await t.query(async (ctx) => ({
      machines: await ctx.db.query("machines").collect(),
      sessions: await ctx.db.query("sessions").collect(),
      searchDocuments: await ctx.db.query("searchDocuments").collect(),
      recordStates: await ctx.db.query("recordStates").collect(),
    }));
    expect(state.machines).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
    expect(state.searchDocuments).toHaveLength(0);
    expect(state.recordStates).toHaveLength(0);
  });
});
