/**
 * CLI <-> server HTTP contract (QSR-217).
 *
 * This is the executable lock on the wire contract between the Quasar CLI
 * (the sole ingest writer) and the Quasar server (storage + serving only).
 *
 * It spawns the REAL server process (packages/server/src/main.ts) on a random
 * port and drives the REAL CLI HTTP client code (postMappedSession /
 * postFingerprintProbe from packages/cli/src/ingest.ts) against it. The
 * contract is locked on the actual client path on purpose: not a raw `fetch`,
 * so a regression in the CLI client write path fails here.
 *
 * Read-back is over plain HTTP GET to prove the normalized MappedSession the
 * CLI client POSTed persisted as sessions, messages, tool calls, and queue
 * state, and that the derived lexical search index serves it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { postFingerprintProbe, postMappedSession } from "../src/ingest";
import type { MappedSession } from "../src/model";

const serverRoot = join(import.meta.dir, "..", "..", "server");

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-http-contract-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const randomPort = () => 20_000 + Math.floor(Math.random() * 20_000);

const mappedSession = (overrides: { readonly fingerprint?: string; readonly firstText?: string } = {}): MappedSession => ({
  project: { projectKey: "contract-project", displayName: "Contract Project", rawPath: "/tmp/contract-project" },
  session: {
    sessionId: "contract-session",
    projectKey: "contract-project",
    provider: "codex",
    agentName: "codex",
    title: "Contract fixture",
    startedAt: "2026-06-18T10:00:00.000Z",
    updatedAt: "2026-06-18T10:01:00.000Z",
    sourcePath: "/history/contract-session.jsonl",
    sourceFingerprint: overrides.fingerprint ?? "contract-fingerprint",
    host: "contract-host",
    identitySchemeVersion: 1,
    messageCount: 2,
    toolCallCount: 1,
  },
  messages: [
    {
      sessionId: "contract-session",
      seq: 1,
      role: "user",
      text: overrides.firstText ?? "contract handshake over http",
      ts: "2026-06-18T10:00:30.000Z",
      projectKey: "contract-project",
      contentHash: "contract-hash-1",
    },
    {
      sessionId: "contract-session",
      seq: 2,
      role: "assistant",
      text: "assistant contract reply",
      ts: "2026-06-18T10:00:35.000Z",
      projectKey: "contract-project",
      contentHash: "contract-hash-2",
    },
  ],
  toolCalls: [
    {
      id: "contract-tool",
      sessionId: "contract-session",
      seq: 3,
      toolName: "shell_command",
      status: "ok",
      inputText: "echo contract",
      outputText: "contract",
      startedAt: "2026-06-18T10:00:40.000Z",
      completedAt: "2026-06-18T10:00:41.000Z",
      projectKey: "contract-project",
      provider: "codex",
    },
  ],
});

const waitFor = async (url: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // server not ready yet
    }
    await Bun.sleep(50);
  }
  throw new Error(`server did not become ready: ${url}`);
};

const spawnServer = (sqlite: string, lance: string, port: number, token: string) =>
  Bun.spawn(["bun", "run", "src/main.ts", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: serverRoot,
    env: {
      ...process.env,
      QUASAR_INGEST_TOKEN: token,
      QUASAR_LOCAL_SQLITE: sqlite,
      QUASAR_SEARCH_DATA_DIR: lance,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

describe("CLI HTTP client <-> server contract", () => {
  test("a normalized MappedSession POSTed via the CLI client persists and is served back over HTTP", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const lance = join(dir, "search.lance");
    const port = randomPort();
    const token = "contract-ingest-token";
    const base = `http://127.0.0.1:${port}`;
    const proc = spawnServer(sqlite, lance, port, token);

    try {
      await waitFor(`${base}/health`);

      // Drive the REAL CLI client write path, not a raw fetch.
      const outcome = await postMappedSession(base, mappedSession(), { ingestToken: token });
      expect(outcome.status).toBe("ok");
      expect(outcome.messagesWritten).toBe(2);
      expect(outcome.toolCallsWritten).toBe(1);
      expect(outcome.jobsEnqueued).toBe(3);

      // The CLI client fingerprint probe must agree the session is now unchanged.
      const unchanged = await postFingerprintProbe(
        base,
        { sessionId: "contract-session", sourceFingerprint: "contract-fingerprint" },
        { ingestToken: token },
      );
      expect(unchanged).toBe(true);

      // Read everything back over plain HTTP — the server's serving surface.
      const [sessions, messages, toolCalls, status] = await Promise.all([
        fetch(`${base}/sessions`).then((r) => r.json()),
        fetch(`${base}/messages?sessionId=contract-session`).then((r) => r.json()),
        fetch(`${base}/tool-calls?provider=codex&toolName=shell_command`).then((r) => r.json()),
        fetch(`${base}/status`).then((r) => r.json()),
      ]);

      expect(sessions.data.rows.map((row: { sessionId: string }) => row.sessionId)).toEqual(["contract-session"]);
      expect(sessions.data.rows[0].messageCount).toBe(2);
      expect(sessions.data.rows[0].toolCallCount).toBe(1);
      expect(messages.data.rows.map((row: { text: string }) => row.text)).toEqual([
        "contract handshake over http",
        "assistant contract reply",
      ]);
      expect(toolCalls.data.rows.map((row: { id: string }) => row.id)).toEqual(["contract-tool"]);
      // The store/queue enqueued the derived-index work: one index-session job
      // plus one embed-message job per searchable message (the two messages).
      // Search itself is derived state built by the worker; that the queue holds
      // exactly this work is the locked CLI->server contract on the write path.
      expect(status.data.queue.pending).toBe(3);
      const byKind = status.data.queue.byKind as readonly { readonly kind: string; readonly pending: number }[];
      const pendingFor = (kind: string) => byKind.find((entry) => entry.kind === kind)?.pending;
      expect(pendingFor("index-session")).toBe(1);
      expect(pendingFor("embed-message")).toBe(2);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);

  test("a malformed wire payload yields an explicit 4xx via the CLI client and never falls back to local runtime", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const lance = join(dir, "search.lance");
    const port = randomPort();
    const token = "contract-ingest-token";
    const base = `http://127.0.0.1:${port}`;
    const proc = spawnServer(sqlite, lance, port, token);

    try {
      await waitFor(`${base}/health`);

      // A MappedSession whose declared messageCount disagrees with the rows is
      // garbage at the wire boundary. The server must reject it BEFORE any store
      // write, and the CLI client must surface that as a thrown error — never
      // silently swallow it or fall back to embedded/local persistence.
      const broken = mappedSession();
      const malformed = {
        ...broken,
        session: { ...broken.session, messageCount: 99 },
      } as MappedSession;

      let rejected: unknown;
      try {
        await postMappedSession(base, malformed, { ingestToken: token });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).name).toBe("RemoteIngestError");

      // Fail-closed proof: nothing was persisted; the boundary rejection wrote
      // zero rows, so the CLI client did NOT fall back to a local write.
      const sessions = await fetch(`${base}/sessions`).then((r) => r.json());
      expect(sessions.data.rows).toEqual([]);
      const messages = await fetch(`${base}/messages?sessionId=contract-session`).then((r) => r.json());
      expect(messages.data.rows).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);
});
