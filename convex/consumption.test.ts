/// <reference types="vite/client" />
/**
 * BATTERY (b) — CONSUMPTION
 *
 * Every stored field of every app table must be CONSUMED by at least one
 * serving query — returned to callers or used as a filter. A field nobody
 * reads is dead weight that silently rots; this battery makes that an
 * executable failure instead of a prose rule.
 *
 * Mechanism: the schema's table/field inventory is enumerated PROGRAMMATICALLY
 * (from convex/schema.ts validators at runtime), and FIELD_CONSUMERS below
 * maps each field to the serving query that consumes it plus an executable
 * proof. Adding a stored field without extending the map fails the
 * enumeration test by name; a mapping whose proof no longer holds fails the
 * execution test.
 *
 * Convex component-internal tables would not appear in this schema object and
 * are out of scope by construction.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Quasar = TestConvex<typeof schema>;

const testConvex = () => convexTest(schema, modules);

// ---------------------------------------------------------------------------
// Seed: one project, one committed session with all optional fields set,
// one still-claimed session (so the in-progress claim is observable),
// messages in all three roles, and a tool call with every field populated.
// ---------------------------------------------------------------------------

const PROJECT_KEY = "git:github.com/example/alpha";
const SESSION_ID = "claude:machine:test:aaaa";
const CLAIMED_SESSION_ID = "claude:machine:test:bbbb";
const RUN_ID = "run-battery";
const ACTION_SECRET = "test-action-secret";
process.env.QUASAR_ACTION_SECRET = ACTION_SECRET;
process.env.GOOGLE_API_KEY = "";
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "";
process.env.QUASAR_SEARCH_DATA_DIR ??= mkdtempSync(join(tmpdir(), "quasar-convex-search-"));

const seed = async (t: Quasar) => {
  await t.mutation(api.quasar.upsertProject, {
    projectKey: PROJECT_KEY,
    displayName: "alpha",
    aliases: ["alpha-alias"],
    rawPaths: ["/tmp/alpha"],
  });
  await t.mutation(api.quasar.beginSessionIngest, {
    sessionId: SESSION_ID,
    projectKey: PROJECT_KEY,
    provider: "claude",
    agentName: "claude-code",
    title: "alpha session",
    startedAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T01:00:00Z",
    sourcePath: "/tmp/alpha/session.jsonl",
    sourceFingerprint: '{"size":1,"mtimeMs":2}',
    messageCount: 3,
    toolCallCount: 1,
    runId: RUN_ID,
  });
  await t.mutation(api.quasar.insertMessages, {
    runId: RUN_ID,
    messages: [
      {
        sessionId: SESSION_ID,
        seq: 0,
        role: "user",
        text: "alpha bravo charlie",
        ts: "2026-06-11T00:00:01Z",
        projectKey: PROJECT_KEY,
      },
      {
        sessionId: SESSION_ID,
        seq: 1,
        role: "reasoning",
        text: "golf hotel india",
        projectKey: PROJECT_KEY,
      },
      {
        sessionId: SESSION_ID,
        seq: 1,
        role: "assistant",
        text: "delta echo foxtrot",
        projectKey: PROJECT_KEY,
      },
    ],
  });
  await t.mutation(api.quasar.insertToolCalls, {
    runId: RUN_ID,
    toolCalls: [
      {
        sessionId: SESSION_ID,
        seq: 1,
        toolName: "Bash",
        status: "completed",
        inputText: '{"command":"ls"}',
        outputText: "alpha.txt",
        startedAt: "2026-06-11T00:00:02Z",
        completedAt: "2026-06-11T00:00:03Z",
        projectKey: PROJECT_KEY,
        provider: "claude",
      },
    ],
  });
  await t.mutation(api.quasar.commitSessionIngest, {
    sessionId: SESSION_ID,
    runId: RUN_ID,
  });
  // A second session left mid-claim: its ingestRunId must be visible to ops.
  await t.mutation(api.quasar.beginSessionIngest, {
    sessionId: CLAIMED_SESSION_ID,
    projectKey: PROJECT_KEY,
    provider: "claude",
    agentName: "claude-code",
    sourcePath: "/tmp/alpha/claimed.jsonl",
    sourceFingerprint: '{"size":3,"mtimeMs":4}',
    messageCount: 0,
    toolCallCount: 0,
    runId: RUN_ID,
  });
  await t.mutation(api.quasar.beginSessionIndex, {
    sessionId: CLAIMED_SESSION_ID,
    runId: RUN_ID,
  });
};

// ---------------------------------------------------------------------------
// Serving-query helpers
// ---------------------------------------------------------------------------

const listSessions = async (t: Quasar) =>
  (
    await t.query(api.quasar.listSessions, {
      projectKey: PROJECT_KEY,
      paginationOpts: { numItems: 10, cursor: null },
    })
  ).page;

const committedSession = async (t: Quasar) => {
  const session = (await listSessions(t)).find((row) => row.sessionId === SESSION_ID);
  expect(session).toBeDefined();
  return session!;
};

const readSessionRows = async (t: Quasar) =>
  (
    await t.query(api.quasar.readSession, {
      sessionId: SESSION_ID,
      paginationOpts: { numItems: 10, cursor: null },
    })
  ).page;

const sessionToolCallRows = async (t: Quasar) =>
  (
    await t.query(api.quasar.sessionToolCalls, {
      sessionId: SESSION_ID,
      paginationOpts: { numItems: 10, cursor: null },
    })
  ).page;

const seededProject = async (t: Quasar) => {
  const project = (await t.query(api.quasar.listProjects, {})).find(
    (row) => row.projectKey === PROJECT_KEY,
  );
  expect(project).toBeDefined();
  return project!;
};

// ---------------------------------------------------------------------------
// The field → serving-query map. `via` names the consuming query; `proof`
// asserts the consumption against seeded data.
// ---------------------------------------------------------------------------

interface FieldConsumer {
  readonly via: string;
  readonly proof: (t: Quasar) => Promise<void>;
}

const FIELD_CONSUMERS: Record<string, Record<string, FieldConsumer>> = {
  projects: {
    projectKey: {
      via: "listProjects (returned) + upsert index",
      proof: async (t) => expect((await seededProject(t)).projectKey).toBe(PROJECT_KEY),
    },
    displayName: {
      via: "listProjects (returned)",
      proof: async (t) => expect((await seededProject(t)).displayName).toBe("alpha"),
    },
    aliases: {
      via: "listProjects (returned as aliasCount)",
      proof: async (t) => expect((await seededProject(t)).aliasCount).toBe(1),
    },
    rawPaths: {
      via: "listProjects (returned as rawPathCount)",
      proof: async (t) => expect((await seededProject(t)).rawPathCount).toBe(1),
    },
  },
  sessions: {
    sessionId: {
      via: "listSessions (returned), readSession join key",
      proof: async (t) => expect((await committedSession(t)).sessionId).toBe(SESSION_ID),
    },
    projectKey: {
      via: "listSessions (filtered via by_projectKey)",
      proof: async (t) => {
        expect((await committedSession(t)).projectKey).toBe(PROJECT_KEY);
        const other = await t.query(api.quasar.listSessions, {
          projectKey: "git:github.com/example/none",
          paginationOpts: { numItems: 10, cursor: null },
        });
        expect(other.page).toHaveLength(0);
      },
    },
    provider: {
      via: "listSessions (returned)",
      proof: async (t) => expect((await committedSession(t)).provider).toBe("claude"),
    },
    agentName: {
      via: "listSessions (returned)",
      proof: async (t) => expect((await committedSession(t)).agentName).toBe("claude-code"),
    },
    title: {
      via: "listSessions (returned)",
      proof: async (t) => expect((await committedSession(t)).title).toBe("alpha session"),
    },
    startedAt: {
      via: "listSessions (returned)",
      proof: async (t) =>
        expect((await committedSession(t)).startedAt).toBe("2026-06-11T00:00:00Z"),
    },
    updatedAt: {
      via: "listSessions (returned)",
      proof: async (t) =>
        expect((await committedSession(t)).updatedAt).toBe("2026-06-11T01:00:00Z"),
    },
    sourcePath: {
      via: "listSessions (returned)",
      proof: async (t) =>
        expect((await committedSession(t)).sourcePath).toBe("/tmp/alpha/session.jsonl"),
    },
    sourceFingerprint: {
      via: "listSessions (returned); idempotency signal for ingest",
      proof: async (t) =>
        expect((await committedSession(t)).sourceFingerprint).toBe('{"size":1,"mtimeMs":2}'),
    },
    messageCount: {
      via: "listSessions (returned)",
      proof: async (t) => expect((await committedSession(t)).messageCount).toBe(3),
    },
    toolCallCount: {
      via: "listSessions (returned)",
      proof: async (t) => expect((await committedSession(t)).toolCallCount).toBe(1),
    },
    ingestRunId: {
      via: "listSessions (returned); in-progress-claim visibility",
      proof: async (t) => {
        const rows = await listSessions(t);
        const claimed = rows.find((row) => row.sessionId === CLAIMED_SESSION_ID);
        expect(claimed?.ingestRunId).toBe(RUN_ID);
        const committed = rows.find((row) => row.sessionId === SESSION_ID);
        expect(committed?.ingestRunId).toBeUndefined();
      },
    },
    indexingRunId: {
      via: "listSessions (returned); in-progress-index visibility",
      proof: async (t) => {
        const rows = await listSessions(t);
        const claimed = rows.find((row) => row.sessionId === CLAIMED_SESSION_ID);
        expect(claimed?.indexingRunId).toBe(RUN_ID);
        const committed = rows.find((row) => row.sessionId === SESSION_ID);
        expect(committed?.indexingRunId).toBeUndefined();
      },
    },
    indexingStartedAt: {
      via: "listSessions (returned); stale-index-lock visibility",
      proof: async (t) => {
        const rows = await listSessions(t);
        const claimed = rows.find((row) => row.sessionId === CLAIMED_SESSION_ID);
        expect(typeof claimed?.indexingStartedAt).toBe("number");
        const committed = rows.find((row) => row.sessionId === SESSION_ID);
        expect(committed?.indexingStartedAt).toBeUndefined();
      },
    },
  },
  messages: {
    sessionId: {
      via: "readSession (filtered via by_sessionId_and_seq, returned)",
      proof: async (t) => {
        const rows = await readSessionRows(t);
        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.sessionId === SESSION_ID)).toBe(true);
      },
    },
    seq: {
      via: "readSession (ordered + returned)",
      proof: async (t) =>
        expect((await readSessionRows(t)).map((row) => row.seq)).toEqual([0, 1, 1]),
    },
    role: {
      via: "readSession (returned)",
      proof: async (t) => {
        expect((await readSessionRows(t)).map((row) => row.role)).toEqual([
          "user",
          "reasoning",
          "assistant",
        ]);
      },
    },
    text: {
      via: "readSession (returned)",
      proof: async (t) => {
        expect((await readSessionRows(t)).map((row) => row.text)).toContain(
          "delta echo foxtrot",
        );
      },
    },
    ts: {
      via: "readSession (returned)",
      proof: async (t) =>
        expect((await readSessionRows(t))[0]?.ts).toBe("2026-06-11T00:00:01Z"),
    },
    projectKey: {
      via: "readSession (returned)",
      proof: async (t) => {
        expect((await readSessionRows(t)).every((row) => row.projectKey === PROJECT_KEY)).toBe(
          true,
        );
      },
    },
  },
  embeddingCache: {
    contentHash: {
      via: "embedCache.lookup (filtered via by_contentHash)",
      proof: async (t) => {
        const hash = "test-hash";
        await t.mutation(api.embedCache.store, {
          entries: [{ contentHash: hash, vector: [1, 2, 3] }],
        });
        const found = await t.query(api.embedCache.lookup, { contentHashes: [hash] });
        expect(found[hash]).toBeDefined();
      },
    },
    vector: {
      via: "embedCache.lookup (returned)",
      proof: async (t) => {
        const hash = "test-hash-vector";
        await t.mutation(api.embedCache.store, {
          entries: [{ contentHash: hash, vector: [4, 5, 6] }],
        });
        const found = await t.query(api.embedCache.lookup, { contentHashes: [hash] });
        expect(found[hash]).toEqual([4, 5, 6]);
      },
    },
    createdAt: {
      via: "embedCache.lookup stores a creation timestamp",
      proof: async (t) => {
        const before = Date.now();
        const hash = "test-hash-created";
        await t.mutation(api.embedCache.store, {
          entries: [{ contentHash: hash, vector: [7, 8, 9] }],
        });
        const rows = await t.query(api.embedCache.listForHash, { contentHash: hash });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.createdAt).toBeGreaterThanOrEqual(before);
      },
    },
  },
  toolCalls: {
    sessionId: {
      via: "sessionToolCalls (filtered via by_sessionId_and_seq, returned)",
      proof: async (t) => {
        const rows = await sessionToolCallRows(t);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.sessionId).toBe(SESSION_ID);
      },
    },
    seq: {
      via: "sessionToolCalls (ordered + returned)",
      proof: async (t) => expect((await sessionToolCallRows(t))[0]?.seq).toBe(1),
    },
    toolName: {
      via: "toolCallsByName (filtered via by_projectKey_and_toolName)",
      proof: async (t) => {
        const named = await t.query(api.quasar.toolCallsByName, {
          projectKey: PROJECT_KEY,
          toolName: "Bash",
          paginationOpts: { numItems: 10, cursor: null },
        });
        expect(named.page).toHaveLength(1);
        const other = await t.query(api.quasar.toolCallsByName, {
          projectKey: PROJECT_KEY,
          toolName: "Read",
          paginationOpts: { numItems: 10, cursor: null },
        });
        expect(other.page).toHaveLength(0);
      },
    },
    status: {
      via: "sessionToolCalls (returned)",
      proof: async (t) => expect((await sessionToolCallRows(t))[0]?.status).toBe("completed"),
    },
    inputText: {
      via: "sessionToolCalls / toolCallsByName (returned)",
      proof: async (t) =>
        expect((await sessionToolCallRows(t))[0]?.inputText).toBe('{"command":"ls"}'),
    },
    outputText: {
      via: "sessionToolCalls / toolCallsByName (returned)",
      proof: async (t) => expect((await sessionToolCallRows(t))[0]?.outputText).toBe("alpha.txt"),
    },
    startedAt: {
      via: "sessionToolCalls (returned)",
      proof: async (t) =>
        expect((await sessionToolCallRows(t))[0]?.startedAt).toBe("2026-06-11T00:00:02Z"),
    },
    completedAt: {
      via: "sessionToolCalls (returned)",
      proof: async (t) =>
        expect((await sessionToolCallRows(t))[0]?.completedAt).toBe("2026-06-11T00:00:03Z"),
    },
    projectKey: {
      via: "toolCallsByName (filtered via by_projectKey_and_toolName)",
      proof: async (t) => {
        const elsewhere = await t.query(api.quasar.toolCallsByName, {
          projectKey: "git:github.com/example/none",
          toolName: "Bash",
          paginationOpts: { numItems: 10, cursor: null },
        });
        expect(elsewhere.page).toHaveLength(0);
      },
    },
    provider: {
      via: "sessionToolCalls (returned)",
      proof: async (t) => expect((await sessionToolCallRows(t))[0]?.provider).toBe("claude"),
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const schemaFields = (): { table: string; field: string }[] =>
  Object.entries(schema.tables).flatMap(([table, definition]) => {
    const validator = (definition as { validator: { kind: string; fields?: object } }).validator;
    if (validator.kind !== "object" || validator.fields === undefined) {
      throw new Error(
        `consumption battery only knows object-shaped tables; ${table} is ${validator.kind} — extend the battery`,
      );
    }
    return Object.keys(validator.fields).map((field) => ({ table, field }));
  });

describe("consumption: every stored field has a serving reader", () => {
  test("every schema field is mapped to a serving query (a new unmapped field fails here)", () => {
    for (const { table, field } of schemaFields()) {
      const consumer = FIELD_CONSUMERS[table]?.[field];
      expect(
        consumer,
        `schema field ${table}.${field} has no serving-query consumer — either wire it into a serving query and map it in FIELD_CONSUMERS, or do not store it`,
      ).toBeDefined();
    }
  });

  test("the consumer map carries no stale entries for removed fields", () => {
    const live = new Set(schemaFields().map(({ table, field }) => `${table}.${field}`));
    for (const [table, fields] of Object.entries(FIELD_CONSUMERS)) {
      for (const field of Object.keys(fields)) {
        expect(
          live.has(`${table}.${field}`),
          `FIELD_CONSUMERS maps ${table}.${field}, which no longer exists in the schema`,
        ).toBe(true);
      }
    }
  });

  test("every mapped consumption proof holds against seeded data", async () => {
    const t = testConvex();
    await seed(t);
    for (const { table, field } of schemaFields()) {
      const consumer = FIELD_CONSUMERS[table]?.[field];
      if (consumer === undefined) continue; // the enumeration test names it
      try {
        await consumer.proof(t);
      } catch (error) {
        throw new Error(
          `consumption proof failed for ${table}.${field} (via ${consumer.via}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  });
});
