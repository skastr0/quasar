import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { cursorAdapter } from "../src/adapters/cursor";
import {
  CursorToolCallBlockSchema,
  classifyCursorMessage,
} from "../src/adapters/cursor-schema";
import { isSignal } from "../src/adapters/harness-schema";

const MACHINE = {
  machineId: "machine:test",
  hostname: "cursor-test-host",
  platform: "darwin",
};
const NOW = "2026-07-13T00:00:00.000Z";
const CREATED_AT = 1_700_000_000_000;
const UPDATED_AT = 1_700_000_100_000;
const SESSION_ID = "8fd16ca4-4dfa-4fea-8c37-4df7c63c5577";
const ACP_SESSION_ID = "ebc30bb2-a3b2-48de-91fd-dd1609ff2911";
const testRoot = mkdtempSync(join(tmpdir(), "quasar-cursor-test-"));
const openDatabases: Database[] = [];

afterAll(() => {
  for (const db of openDatabases) db.close();
  rmSync(testRoot, { recursive: true, force: true });
});

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const utf8 = (value: string) => Buffer.from(value, "utf8");

const diagnosticName = (details: unknown) => {
  if (typeof details !== "object" || details === null || !(("diagnostic") in details)) {
    return undefined;
  }
  return typeof details.diagnostic === "string" ? details.diagnostic : undefined;
};

const encodeVarint = (value: number) => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
};

const fieldBytes = (fieldNumber: number, value: Uint8Array) =>
  Buffer.concat([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(value.length),
    Buffer.from(value),
  ]);

const fieldVarint = (fieldNumber: number, value: number) =>
  Buffer.concat([encodeVarint(fieldNumber << 3), encodeVarint(value)]);

type FixtureKind = "chat" | "acp";

type StoreFixture = {
  readonly root: string;
  readonly db: Database;
  readonly dbPath: string;
  readonly rootBlobId: string;
  readonly staleMessageBlobId: string;
  readonly activeMessageBlobId: string;
};

const createStore = (
  name: string,
  options: {
    readonly kind?: FixtureKind;
    readonly sessionId?: string;
    readonly metadataSessionId?: string;
    readonly malformedRoot?: boolean;
    readonly includeTranscript?: boolean;
  } = {},
): StoreFixture => {
  const root = join(testRoot, name);
  const cwd = join(testRoot, "project-worktree");
  mkdirSync(cwd, { recursive: true });
  const kind = options.kind ?? "chat";
  const nativeSessionId = options.sessionId ?? SESSION_ID;
  const workspace = createHash("md5").update(resolve(cwd)).digest("hex");
  const sessionDirectory = kind === "chat"
    ? join(root, "chats", workspace, nativeSessionId)
    : join(root, "acp-sessions", nativeSessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const dbPath = join(sessionDirectory, "store.db");
  const db = new Database(dbPath);
  openDatabases.push(db);
  db.exec("pragma journal_mode = WAL");
  db.exec("pragma synchronous = NORMAL");
  db.exec("pragma wal_autocheckpoint = 0");
  db.exec("pragma user_version = 1");
  db.exec("create table blobs (id text primary key, data blob)");
  db.exec("create table meta (key text primary key, value text)");
  const insertBlob = db.query("insert into blobs (id, data) values (?, ?)");
  const addBlob = (bytes: Uint8Array) => {
    const id = hex(hash(bytes));
    insertBlob.run(id, bytes);
    return { id, ref: hash(bytes) };
  };
  const addMessage = (message: unknown) => addBlob(utf8(JSON.stringify(message)));

  const archived = addMessage({ role: "user", content: [{ type: "text", text: "Archived prompt" }] });
  const summaryReplacement = addMessage({
    role: "assistant",
    id: "summary-message",
    content: [{ type: "text", text: "Synthetic recovered summary" }],
    providerOptions: { cursor: { isSummary: true } },
  });
  const system = addMessage({ role: "system", content: "System policy" });
  const assistant = addMessage({
    role: "assistant",
    id: "assistant-message",
    content: [
      {
        type: "reasoning",
        text: "Reason through the fixture",
        signature: "opaque-signature-must-not-surface",
        providerOptions: { cursor: { modelName: "cursor-model" } },
      },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        args: {
          path: "src/a.ts",
          binary: { __type: "Uint8Array", hex: "deadbeef" },
        },
      },
      { type: "text", text: "Final answer" },
    ],
    providerOptions: { cursor: { modelProviderMessageId: "provider-message-1" } },
  });
  const result = addMessage({
    role: "tool",
    id: "tool-message",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read_file",
        result: "{\"ok\":true}",
        experimental_content: [{ type: "text", text: "ok" }],
      },
    ],
    providerOptions: {
      cursor: { highLevelToolCallResult: { isError: false, output: { ok: true } } },
    },
  });
  const unknownThenText = addMessage({
    role: "user",
    content: [
      { type: "future-cursor-block", payload: "must be dropped by name" },
      { type: "text", text: "Tail after unknown block" },
    ],
  });
  const stale = addMessage({ role: "user", content: [{ type: "text", text: "UNREACHABLE STALE MESSAGE" }] });
  const oldRoot = addBlob(fieldBytes(1, stale.ref));

  const archiveBytes = Buffer.concat([
    fieldBytes(1, archived.ref),
    fieldBytes(2, utf8("summary body")),
    fieldVarint(3, 1),
    fieldBytes(4, summaryReplacement.ref),
  ]);
  const archive = addBlob(archiveBytes);
  const rootBytes = options.malformedRoot === true
    ? Buffer.from([0x0a, 0x20, 0xff])
    : Buffer.concat([
        fieldBytes(1, summaryReplacement.ref),
        fieldBytes(1, system.ref),
        fieldBytes(1, assistant.ref),
        fieldBytes(1, result.ref),
        fieldBytes(1, unknownThenText.ref),
        fieldBytes(13, archive.ref),
      ]);
  const currentRoot = addBlob(rootBytes);

  const metadata = {
    agentId: options.metadataSessionId ?? nativeSessionId,
    latestRootBlobId: currentRoot.id,
    name: "Cursor Fixture",
    createdAt: CREATED_AT,
    mode: "default",
    isRunEverything: false,
    approvalMode: "default",
    lastUsedModel: "fallback-model",
  };
  db.query("insert into meta (key, value) values (?, ?)").run(
    "0",
    utf8(JSON.stringify(metadata)).toString("hex"),
  );
  const sidecar = kind === "chat"
    ? {
        schemaVersion: 1,
        createdAtMs: CREATED_AT,
        hasConversation: true,
        title: "Sidecar title",
        updatedAtMs: UPDATED_AT,
        cwd,
      }
    : { schemaVersion: 1, cwd, title: "ACP title" };
  writeFileSync(join(sessionDirectory, "meta.json"), JSON.stringify(sidecar), "utf8");
  if (kind === "acp") {
    const date = new Date(UPDATED_AT);
    utimesSync(dbPath, date, date);
  }
  if (options.includeTranscript === true) {
    const transcriptDirectory = join(root, "projects", "project-worktree", "agent-transcripts", nativeSessionId);
    mkdirSync(transcriptDirectory, { recursive: true });
    writeFileSync(
      join(transcriptDirectory, `${nativeSessionId}.jsonl`),
      `${JSON.stringify({ role: "user", text: "derived duplicate" })}\n`,
      "utf8",
    );
  }
  expect(oldRoot.id).not.toBe(currentRoot.id);
  return {
    root,
    db,
    dbPath,
    rootBlobId: currentRoot.id,
    staleMessageBlobId: stale.id,
    activeMessageBlobId: assistant.id,
  };
};

const readRoot = (root: string) => cursorAdapter.read({
  machine: MACHINE,
  now: NOW,
  roots: { cursor: root },
});

describe("Cursor Agent-KV adapter", () => {
  test("hydrates only current-root archives plus active refs in provider order", async () => {
    const fixture = createStore("authoritative", { includeTranscript: true });
    const result = await readRoot(fixture.root);
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;

    expect(session.provider).toBe("cursor");
    expect(session.agentName).toBe("cursor-agent");
    expect(session.nativeSessionId).toBe(SESSION_ID);
    expect(session.title).toBe("Cursor Fixture");
    expect(session.startedAt).toBe(new Date(CREATED_AT).toISOString());
    expect(session.updatedAt).toBe(new Date(UPDATED_AT).toISOString());
    expect(session.events.map((event) => event.contentText)).toEqual([
      "Archived prompt",
      "System policy",
      "Reason through the fixture",
      undefined,
      "Final answer",
      "{\"ok\":true}",
      "Tail after unknown block",
    ]);
    expect(session.events.map((event) => [event.role, event.kind])).toEqual([
      ["user", "message"],
      ["system", "system"],
      ["thinking", "reasoning"],
      ["assistant", "tool_call"],
      ["assistant", "message"],
      ["tool", "tool_result"],
      ["user", "message"],
    ]);
    expect(session.events.some((event) => event.contentText?.includes("Synthetic recovered summary"))).toBe(false);
    expect(session.events.some((event) => event.contentText?.includes("UNREACHABLE STALE MESSAGE"))).toBe(false);
    expect(session.events.some((event) => event.rawReference.rowId === fixture.staleMessageBlobId)).toBe(false);
    expect(session.events.flatMap((event) => event.contentBlocks).some((block) =>
      JSON.stringify(block).includes("opaque-signature"))).toBe(false);

    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]).toMatchObject({
      toolName: "read_file",
      status: "completed",
      input: {
        path: "src/a.ts",
        binary: { __type: "OpaqueBinary", byteLength: 4 },
      },
      output: { ok: true },
    });
    expect(session.sessionEdges.some((edge) => edge.kind === "tool_result_for")).toBe(true);
    expect(session.usageRecords).toHaveLength(1);
    expect(session.usageRecords[0]).toMatchObject({ model: "cursor-model", modelProvider: "cursor" });
    expect(JSON.stringify(session)).not.toContain("deadbeef");
    expect(result.diagnostics.some((diagnostic) =>
      diagnosticName(diagnostic.details) === "cursor.blob.binary_opaque")).toBe(true);
    expect(result.diagnostics.some((diagnostic) =>
      diagnosticName(diagnostic.details) === "cursor.block.unknown_type")).toBe(true);
    expect(result.diagnostics.some((diagnostic) =>
      diagnosticName(diagnostic.details) === "cursor.transcript.duplicate_incomplete")).toBe(true);
  });

  test("discovers ACP stores through the same current-root decoder", async () => {
    const fixture = createStore("acp", { kind: "acp", sessionId: ACP_SESSION_ID });
    const result = await readRoot(fixture.root);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.nativeSessionId).toBe(ACP_SESSION_ID);
    expect(result.sessions[0]!.agentName).toBe("cursor-agent-acp");
    expect(result.sessions[0]!.events[0]!.contentText).toBe("Archived prompt");
  });

  test("rejects an authoritative root when any referenced message blob is unavailable", async () => {
    const fixture = createStore("missing-child");
    const database = new Database(fixture.dbPath);
    database.query("delete from blobs where id = ?").run(fixture.activeMessageBlobId);
    database.close();

    const result = await readRoot(fixture.root);
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.some((diagnostic) =>
      diagnosticName(diagnostic.details) === "cursor.merkle.incomplete")).toBe(true);
  });

  test("canonical ID is independent of the physical Cursor root", async () => {
    const first = createStore("stable-host");
    const second = createStore("stable-container");
    const firstSession = (await readRoot(first.root)).sessions[0]!;
    const secondSession = (await readRoot(second.root)).sessions[0]!;
    expect(firstSession.id).toBe(secondSession.id);
    expect(firstSession.sourcePath).not.toBe(secondSession.sourcePath);
  });

  test("canonicalizes equivalent metadata and directory UUID casing", async () => {
    const uppercaseMetadata = createStore("uppercase-metadata", {
      sessionId: SESSION_ID,
      metadataSessionId: SESSION_ID.toUpperCase(),
    });
    const uppercaseDirectory = createStore("uppercase-directory", {
      sessionId: SESSION_ID.toUpperCase(),
      metadataSessionId: SESSION_ID,
    });

    const metadataSession = (await readRoot(uppercaseMetadata.root)).sessions[0]!;
    const directorySession = (await readRoot(uppercaseDirectory.root)).sessions[0]!;
    expect(metadataSession.id).toBe(directorySession.id);
    expect(metadataSession.nativeSessionId).toBe(SESSION_ID);
    expect(directorySession.nativeSessionId).toBe(SESSION_ID);
  });

  test("malformed current root fails closed with a named graph diagnostic", async () => {
    const fixture = createStore("malformed-root", { malformedRoot: true });
    const result = await readRoot(fixture.root);
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.some((diagnostic) =>
      diagnosticName(diagnostic.details) === "cursor.root_blob.decode_failed")).toBe(true);
  });

  test("hash-mismatched current root is rejected before protobuf decoding", async () => {
    const fixture = createStore("hash-mismatch");
    fixture.db.query("update blobs set data = ? where id = ?").run(
      Buffer.from("mutated root bytes", "utf8"),
      fixture.rootBlobId,
    );
    const result = await readRoot(fixture.root);
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.some((diagnostic) =>
      diagnosticName(diagnostic.details) === "cursor.merkle.hash_mismatch")).toBe(true);
  });

  test("stat gate prevents snapshot/read and parse gate prevents root hydration", async () => {
    const fixture = createStore("gates");
    const statPaths: string[] = [];
    const statGated = await cursorAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { cursor: fixture.root },
      shouldReadFile: (path) => {
        statPaths.push(path);
        return false;
      },
    });
    expect(statPaths).toContain(fixture.dbPath);
    expect(statGated.sessions).toHaveLength(0);

    const probes: { readonly sessionId: string; readonly sourceFingerprint: string }[] = [];
    const parseGated = await cursorAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { cursor: fixture.root },
      shouldParseSession: (probe) => {
        probes.push(probe);
        return false;
      },
    });
    expect(probes).toHaveLength(1);
    expect(JSON.parse(probes[0]!.sourceFingerprint)).toHaveProperty("tag");
    expect(parseGated.sessions).toHaveLength(0);
  });

  test("closed block schema and message classifier reject malformed or unknown variants", () => {
    const malformedCall = Schema.decodeUnknownEither(CursorToolCallBlockSchema)({
      type: "tool-call",
      toolCallId: "call",
      args: {},
    });
    expect(Either.isLeft(malformedCall)).toBe(true);
    const classification = classifyCursorMessage({ role: "future-role", content: "payload" });
    expect(isSignal(classification)).toBe(false);
    if (!isSignal(classification)) expect(classification.reason).toContain("cursor.message.invalid_role");
  });
});
