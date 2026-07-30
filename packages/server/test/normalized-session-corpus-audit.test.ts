import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  decodeMappedSessionSync,
  mappedSessionExamples,
  messageContentHash,
} from "@skastr0/quasar-protocol";
import { Effect } from "effect";

import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];
const repositoryRoot = resolve(import.meta.dir, "../../..");
const auditEntrypoint = join(
  repositoryRoot,
  "packages/server/src/normalizedSessionCorpusAuditCli.ts",
);

const tempDatabase = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "quasar-corpus-audit-"));
  tempDirs.push(directory);
  return join(directory, "quasar.sqlite");
};

const fileState = (path: string) => {
  const state = (filePath: string) => {
    try {
      const stat = statSync(filePath);
      return {
        exists: true,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: string }).code === "ENOENT"
      ) {
        return { exists: false };
      }
      throw error;
    }
  };
  return {
    database: state(path),
    wal: state(`${path}-wal`),
    shm: state(`${path}-shm`),
  };
};

/** Content identity only — ignore WAL/SHM mtime (Linux plain-readonly fallback). */
const assertDbBytesUnchanged = (
  before: ReturnType<typeof fileState>,
  after: ReturnType<typeof fileState>,
): void => {
  expect(after.database.exists).toBe(true);
  expect(after.database.size).toBe(before.database.size);
  if (before.wal.exists) {
    expect(after.wal.exists).toBe(true);
    expect(after.wal.size).toBe(before.wal.size);
  }
};

const seedDatabase = async (path: string) => {
  const source = decodeMappedSessionSync(
    structuredClone(mappedSessionExamples[0]!.input),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* LocalStore;
      yield* store.upsertSession(source);
      yield* store.finalizeSessionIngest(
        source.session.sessionId,
        source.session.sourceFingerprint,
        source.session.normalizationVersion,
      );
    }).pipe(Effect.provide(makeLocalStoreLayer(path))),
  );
  return source;
};

const checkpointDatabase = (path: string): void => {
  const database = new Database(path);
  database.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  database.close();
};

const runAudit = async (path: string) => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      auditEntrypoint,
      "--db",
      path,
      "--progress-every",
      "1",
    ],
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("normalized session corpus audit", () => {
  test("validates projections without touching SQLite or exposing source identity", async () => {
    const path = tempDatabase();
    const source = await seedDatabase(path);
    checkpointDatabase(path);
    const before = fileState(path);

    const result = await runAudit(path);

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ok: true,
      command: "normalized-session-corpus-audit",
      sessionsDiscovered: 1,
      mappedSessions: 1,
      projections: {
        quasar: 1,
        letta: 1,
        atif: 1,
        recursiveAtifRoots: 0,
      },
      errors: {
        count: 0,
        distinct: 0,
        returned: 0,
        truncated: false,
        failures: [],
      },
    });
    expect(report.facts.contentBlocks).toBe(
      source.events.reduce(
        (count, event) => count + event.contentBlocks.length,
        0,
      ),
    );
    expect(report.compatibility.letta.issuesByKind)
      .toHaveProperty("quasar_metadata_omitted");
    expect(report.compatibility.atif.singleSession.sourceSessions).toBe(1);
    expect(report.providers[source.session.provider].sessions).toBe(1);

    expect(result.stdout).not.toContain(path);
    expect(result.stdout).not.toContain(source.session.sessionId);
    expect(result.stderr).not.toContain(path);
    expect(result.stderr).not.toContain(source.session.sessionId);
    assertDbBytesUnchanged(before, fileState(path));
  });

  test("validates a complete recursive ATIF descendant tree", async () => {
    const path = tempDatabase();
    const parent = await seedDatabase(path);
    const childValue: any = structuredClone(mappedSessionExamples[0]!.input);
    const childSessionId = `${parent.session.provider}:audit-child`;
    const childEventId = `${childSessionId}:event:0`;
    childValue.session.sessionId = childSessionId;
    childValue.session.parentSessionId = parent.session.sessionId;
    childValue.session.sourcePath = "/history/audit-child.jsonl";
    childValue.session.sourceFingerprint = "audit-child-fingerprint";
    childValue.events[0].id = childEventId;
    childValue.events[0].sessionId = childSessionId;
    childValue.events[0].nativeEventId = "audit-child-native-event";
    childValue.events[0].rawReference.sourcePath =
      childValue.session.sourcePath;
    childValue.messages[0].sessionId = childSessionId;
    childValue.messages[0].eventId = childEventId;
    childValue.messages[0].contentHash = messageContentHash({
      sessionId: childSessionId,
      eventId: childEventId,
      seq: childValue.messages[0].seq,
      role: childValue.messages[0].role,
      text: childValue.messages[0].text,
    });
    childValue.sessionEdges = [{
      id: `${childSessionId}:edge:parent`,
      sessionId: childSessionId,
      machineId: childValue.events[0].machineId,
      provider: childValue.session.provider,
      agentName: childValue.session.agentName,
      projectIdentityKey: childValue.session.projectKey,
      kind: "subagent_of",
      fromId: parent.session.sessionId,
      toId: childSessionId,
    }];
    const child = decodeMappedSessionSync(childValue);

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        yield* store.upsertSession(child);
        yield* store.finalizeSessionIngest(
          child.session.sessionId,
          child.session.sourceFingerprint,
          child.session.normalizationVersion,
        );
      }).pipe(Effect.provide(makeLocalStoreLayer(path))),
    );
    checkpointDatabase(path);
    const before = fileState(path);

    const result = await runAudit(path);

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ok: true,
      sessionsDiscovered: 2,
      mappedSessions: 2,
      projections: {
        quasar: 2,
        letta: 2,
        atif: 2,
        recursiveAtifRoots: 1,
      },
      lineage: {
        childSessions: 1,
        danglingParentSessions: 0,
        completeRoots: 1,
      },
    });
    expect(report.compatibility.atif.recursive).toMatchObject({
      sourceSessions: 2,
      embeddedSubagents: 1,
    });
    expect(result.stdout).not.toContain(parent.session.sessionId);
    expect(result.stdout).not.toContain(child.session.sessionId);
    assertDbBytesUnchanged(before, fileState(path));
  });

  test("groups failures into content-free diagnostics", async () => {
    const path = tempDatabase();
    const source = await seedDatabase(path);
    const sensitiveMarker = `${source.session.sessionId}:${path}`;
    const database = new Database(path);
    database.query(
      "UPDATE session_events SET event_json = ? WHERE session_id = ?",
    ).run(JSON.stringify({ id: sensitiveMarker }), source.session.sessionId);
    database.close();
    checkpointDatabase(path);
    const before = fileState(path);

    const result = await runAudit(path);

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.errors).toMatchObject({
      count: 1,
      distinct: 1,
      returned: 1,
      truncated: false,
    });
    expect(report.errors.failures[0]).toMatchObject({
      stage: "read",
      provider: source.session.provider,
      errorType: expect.any(String),
      errorFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      count: 1,
    });
    expect(result.stdout).not.toContain(path);
    expect(result.stdout).not.toContain(source.session.sessionId);
    expect(result.stdout).not.toContain(sensitiveMarker);
    expect(result.stderr).not.toContain(path);
    expect(result.stderr).not.toContain(source.session.sessionId);
    assertDbBytesUnchanged(before, fileState(path));
  });

  test("refuses an uncheckpointed WAL without touching proof state", async () => {
    const path = tempDatabase();
    const source = await seedDatabase(path);
    const writer = new Database(path);
    writer.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE audit_wal_probe(value TEXT)",
    );
    const before = fileState(path);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

    const result = await runAudit(path);

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ok: false,
      command: "normalized-session-corpus-audit",
      errors: {
        count: 1,
        distinct: 1,
        returned: 1,
        truncated: false,
        failures: [{
          stage: "read",
          provider: "unknown",
          errorType: "Error",
          errorFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          count: 1,
        }],
      },
    });
    expect(result.stdout).not.toContain(path);
    expect(result.stdout).not.toContain(source.session.sessionId);
    expect(result.stderr).not.toContain(path);
    expect(result.stderr).not.toContain(source.session.sessionId);
    assertDbBytesUnchanged(before, fileState(path));
    writer.close();
  });

  test("reports an unavailable database without echoing its path", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "quasar-corpus-audit-missing-")),
      "sensitive-database-name.sqlite",
    );
    tempDirs.push(resolve(path, ".."));

    const result = await runAudit(path);

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ok: false,
      command: "normalized-session-corpus-audit",
      errors: {
        count: 1,
        distinct: 1,
        returned: 1,
        truncated: false,
      },
    });
    expect(result.stdout).not.toContain(path);
    expect(result.stdout).not.toContain("sensitive-database-name");
    expect(result.stderr).not.toContain(path);
    expect(result.stderr).not.toContain("sensitive-database-name");
  });
});
