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

import type { MappedSession } from "../src/model";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const proofEntrypoint = join(
  repositoryRoot,
  "packages/server/src/normalizedSessionReplayProofCli.ts",
);
const tempDirs: string[] = [];

const tempDatabase = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "quasar-replay-proof-"));
  tempDirs.push(directory);
  return join(directory, "quasar.sqlite");
};

const fixture = (
  provider: "codex" | "hermes" | "kimi",
  suffix: string,
): MappedSession => {
  const source: any = structuredClone(mappedSessionExamples[0]!.input);
  const sessionId = `${provider}:${suffix}`;
  const eventId = `${sessionId}:event:0`;
  source.session = {
    ...source.session,
    sessionId,
    provider,
    agentName: provider,
    title: `private title ${suffix}`,
    sourcePath: `/private/${suffix}.jsonl`,
    sourceFingerprint: `fingerprint-${suffix}`,
  };
  const text = `private message ${suffix}`;
  source.messages = source.messages.map((message: any) => ({
    ...message,
    sessionId,
    eventId,
    text,
    contentHash: messageContentHash({
      sessionId,
      eventId,
      seq: message.seq,
      role: message.role,
      text,
    }),
  }));
  source.events = source.events.map((event: any) => ({
    ...event,
    id: eventId,
    sessionId,
    provider,
    agentName: provider,
    contentText: `private message ${suffix}`,
    rawReference: {
      ...event.rawReference,
      sourcePath: `/private/${suffix}.jsonl`,
    },
  }));
  return decodeMappedSessionSync(source);
};

const seedDatabase = async (
  path: string,
  sessions: readonly MappedSession[],
): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* LocalStore;
      for (const session of sessions) {
        yield* store.upsertSession(session);
        yield* store.finalizeSessionIngest(
          session.session.sessionId,
          session.session.sourceFingerprint,
          session.session.normalizationVersion,
        );
      }
    }).pipe(Effect.provide(makeLocalStoreLayer(path))),
  );
  const database = new Database(path);
  database.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  database.close();
};

const fileState = (path: string) => {
  const read = (filePath: string) => {
    try {
      const stat = statSync(filePath);
      return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { readonly code?: string }).code === "ENOENT"
      ) {
        return { exists: false };
      }
      throw error;
    }
  };
  return {
    database: read(path),
    wal: read(`${path}-wal`),
    shm: read(`${path}-shm`),
  };
};

interface RequestReceipt {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly token: string | null;
  readonly body?: any;
}

const startProofServer = (options: {
  readonly healthSqlite: string;
  readonly outcome?: (
    index: number,
    session: MappedSession,
  ) => Record<string, unknown>;
}) => {
  const requests: RequestReceipt[] = [];
  let postIndex = 0;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const receipt: RequestReceipt = {
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        token: request.headers.get("x-quasar-ingest-token"),
      };
      if (request.method === "GET" && url.pathname === "/health") {
        requests.push(receipt);
        return json({
          ok: true,
          command: "health",
          data: { status: "ok", sqlite: options.healthSqlite },
        });
      }
      if (request.method === "GET" && url.pathname === "/status") {
        requests.push(receipt);
        return json({
          ok: true,
          command: "status",
          data: {
            queue: { pending: 0, leased: 0, failed: 0 },
            ingest: { activeRuns: 0 },
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/ingest/session") {
        const body = await request.json() as any;
        requests.push({ ...receipt, body });
        const session = body.session as MappedSession;
        const outcome = options.outcome?.(postIndex, session) ?? {
          sessionId: session.session.sessionId,
          status: "skipped",
          diagnostic: "unchanged_source_fingerprint",
          messagesWritten: 0,
          toolCallsWritten: 0,
          jobsEnqueued: 0,
        };
        postIndex += 1;
        return json({
          ok: true,
          command: "ingest/session",
          data: { outcome },
        });
      }
      requests.push(receipt);
      return json({ ok: false }, 404);
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
};

const runProof = async (path: string, server: string) => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      proofEntrypoint,
      "--db",
      path,
      "--server",
      server,
    ],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      QUASAR_INGEST_TOKEN: "proof-token",
    },
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

describe("normalized session replay proof", () => {
  test("proves every exact stored session is an unchanged skip", async () => {
    const path = tempDatabase();
    const sessions = [
      fixture("hermes", "bravo"),
      fixture("codex", "alpha"),
    ];
    await seedDatabase(path, sessions);
    const before = fileState(path);
    const server = startProofServer({ healthSqlite: path });

    try {
      const result = await runProof(path, server.base);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        ok: true,
        command: "normalized-session-replay-proof",
        sessionsDiscovered: 2,
        sessionsAttempted: 2,
        sessionsVerified: 2,
        providers: {
          codex: { sessions: 1, attempted: 1, skipped: 1 },
          hermes: { sessions: 1, attempted: 1, skipped: 1 },
        },
        writes: { messages: 0, toolCalls: 0, jobs: 0 },
        preflight: {
          walBytes: 0,
          targetMatched: true,
          queue: { pending: 0, leased: 0, failed: 0 },
          activeIngestRuns: 0,
          applyingFingerprints: 0,
        },
        errors: {
          count: 0,
          distinct: 0,
          returned: 0,
          truncated: false,
          failures: [],
        },
      });

      expect(server.requests.map(({ method, pathname }) => `${method} ${pathname}`))
        .toEqual([
          "GET /health",
          "GET /status",
          "POST /ingest/session",
          "POST /ingest/session",
        ]);
      const posts = server.requests.filter(({ method }) => method === "POST");
      expect(posts.map(({ body }) => body.session)).toEqual([
        sessions[1],
        sessions[0],
      ]);
      expect(posts.every(({ search }) => search === "")).toBe(true);
      expect(posts.every(({ token }) => token === "proof-token")).toBe(true);
      expect(fileState(path)).toEqual(before);
      for (const session of sessions) {
        expect(result.stdout).not.toContain(session.session.sessionId);
        expect(result.stdout).not.toContain(session.messages[0]!.text);
      }
      expect(result.stdout).not.toContain(path);
    } finally {
      await server.stop();
    }
  });

  test("rejects a loopback server backed by a different database", async () => {
    const path = tempDatabase();
    const session = fixture("codex", "wrong-target");
    await seedDatabase(path, [session]);
    const server = startProofServer({
      healthSqlite: join(resolve(path, ".."), "other.sqlite"),
    });

    try {
      const result = await runProof(path, server.base);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        ok: false,
        sessionsAttempted: 0,
        sessionsVerified: 0,
        errors: {
          count: 1,
          failures: [{
            stage: "target",
            provider: "unknown",
            errorType: "ReplayProofViolation",
            errorFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
            count: 1,
          }],
        },
      });
      expect(server.requests.map(({ pathname }) => pathname)).toEqual(["/health"]);
      expect(result.stdout).not.toContain(path);
      expect(result.stdout).not.toContain(session.session.sessionId);
    } finally {
      await server.stop();
    }
  });

  test("stops at the first response that reports a write", async () => {
    const path = tempDatabase();
    const sessions = [
      fixture("kimi", "charlie"),
      fixture("hermes", "bravo"),
      fixture("codex", "alpha"),
    ];
    await seedDatabase(path, sessions);
    const server = startProofServer({
      healthSqlite: path,
      outcome: (index, session) =>
        index === 0
          ? {
              sessionId: session.session.sessionId,
              status: "skipped",
              diagnostic: "unchanged_source_fingerprint",
              messagesWritten: 0,
              toolCallsWritten: 0,
              jobsEnqueued: 0,
            }
          : {
              sessionId: session.session.sessionId,
              status: "ok",
              messagesWritten: 1,
              toolCallsWritten: 0,
              jobsEnqueued: 0,
            },
    });

    try {
      const result = await runProof(path, server.base);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        ok: false,
        sessionsDiscovered: 3,
        sessionsAttempted: 2,
        sessionsVerified: 1,
        providers: {
          codex: { sessions: 1, attempted: 1, skipped: 1 },
          hermes: { sessions: 1, attempted: 1, skipped: 0 },
          kimi: { sessions: 1, attempted: 0, skipped: 0 },
        },
        writes: { messages: 1, toolCalls: 0, jobs: 0 },
        errors: {
          count: 1,
          failures: [{
            stage: "response",
            provider: "hermes",
            errorType: "ReplayProofViolation",
            errorFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
            count: 1,
          }],
        },
      });
      expect(
        server.requests.filter(({ method }) => method === "POST").map(
          ({ body }) => body.session.session.sessionId,
        ),
      ).toEqual([
        sessions[2]!.session.sessionId,
        sessions[1]!.session.sessionId,
      ]);
      for (const session of sessions) {
        expect(result.stdout).not.toContain(session.session.sessionId);
        expect(result.stdout).not.toContain(session.messages[0]!.text);
      }
      expect(result.stdout).not.toContain(path);
    } finally {
      await server.stop();
    }
  });
});
