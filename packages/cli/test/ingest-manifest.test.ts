import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NormalizedSession } from "../src/core/schemas";
import { afterEach, describe, expect, test } from "bun:test";

import { adaptersByProvider } from "../src/adapters/registry";
import type { AdapterDiscoverOptions, SessionAdapter } from "../src/adapters/types";
import { ingestRemote, loadManifest } from "../src/ingest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const realClaudeAdapter = adaptersByProvider.get("claude");
afterEach(() => {
  if (realClaudeAdapter) adaptersByProvider.set("claude", realClaudeAdapter);
  else adaptersByProvider.delete("claude");
});

const session = (id: string, sourcePath: string): NormalizedSession => ({
  id,
  nativeSessionId: id,
  provider: "claude",
  agentName: "test-agent",
  machineId: "machine-a",
  host: "host-a",
  identitySchemeVersion: 1,
  projectIdentity: {
    projectIdentityKey: "project-a",
    displayName: "Project A",
    confidence: "explicit",
    rawPath: "/tmp/project-a",
    signals: [],
  },
  title: "Manifest test session",
  startedAt: "2026-06-22T10:00:00.000Z",
  updatedAt: "2026-06-22T10:02:00.000Z",
  sourceRoot: "/history",
  sourcePath,
  events: [
    {
      id: `${id}:event-1`,
      sessionId: id,
      sequence: 0,
      timestamp: "2026-06-22T10:00:00.000Z",
      machineId: "machine-a",
      provider: "claude",
      agentName: "test-agent",
      projectIdentityKey: "project-a",
      role: "user",
      kind: "message",
      contentText: "hello",
      contentBlocks: [],
      rawReference: { sourcePath },
    },
  ],
  toolCalls: [],
  sessionEdges: [],
  usageRecords: [],
  artifacts: [],
});

/**
 * Adapter that respects shouldReadFile (the stat gate) before yielding sessions.
 * Tracks which physicalPaths were opened (content read attempted).
 */
const adapterFor = (
  sessions: readonly { session: NormalizedSession; physicalPath: string }[],
  opened: string[],
): SessionAdapter => ({
  id: "manifest-fixture",
  provider: "claude",
  displayName: "Manifest Fixture Adapter",
  stable: true,
  defaultRoot: () => undefined,
  read: async () => ({ sourceRoots: [], sessions: sessions.map((s) => s.session), diagnostics: [] }),
  stream: async function* (opts: AdapterDiscoverOptions) {
    for (const { session: s, physicalPath } of sessions) {
      // Simulate the stat gate that adapters are expected to honour
      try {
        const st = statSync(physicalPath);
        if (opts.shouldReadFile?.(physicalPath, st) === false) {
          // Manifest says skip — no content read
          continue;
        }
      } catch {
        // file missing — skip
        continue;
      }
      opened.push(physicalPath);
      const fingerprint = { tag: `fp:${s.id}` };
      if (
        (await opts.shouldParseSession?.({
          sessionId: s.id,
          sourceFingerprint: JSON.stringify(fingerprint),
        })) === false
      ) {
        continue;
      }
      yield {
        type: "session" as const,
        session: s,
        sourceUnit: {
          provider: "claude" as const,
          adapterId: "manifest-fixture",
          rootPath: "/history",
          sourcePath: physicalPath,
          physicalPath,
        },
        fingerprint,
      };
    }
  },
});

/** Minimal HTTP server that always reports sessions as changed (not cached) and accepts writes. */
const startServer = (token: string) => {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("x-quasar-ingest-token") !== token) {
        return Response.json({ ok: false, error: { message: "missing token" } }, { status: 401 });
      }
      const pathname = new URL(request.url).pathname;
      if (pathname === "/ingest/fingerprint") {
        // Always report changed so server gate never suppresses
        return Response.json({ ok: true, data: { unchanged: false } });
      }
      if (pathname === "/ingest/session") {
        const payload = await request.json() as {
          readonly session: { readonly session: { readonly sessionId: string }; readonly messages: readonly unknown[]; readonly toolCalls: readonly unknown[] };
        };
        return Response.json({
          ok: true,
          data: {
            outcome: {
              sessionId: payload.session.session.sessionId,
              status: "ok",
              messagesWritten: payload.session.messages.length,
              toolCallsWritten: payload.session.toolCalls.length,
              jobsEnqueued: 1,
            },
          },
        });
      }
      return Response.json({ ok: false, error: { message: "not found" } }, { status: 404 });
    },
  });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingest manifest", () => {
  test("second run with unchanged manifest reads zero files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "session-a.jsonl");
    writeFileSync(physicalPath, '{"id":"session-a"}\n', "utf8");

    const s = session("manifest-unchanged-a", physicalPath);
    const server = startServer("tok");

    try {
      const opened1: string[] = [];
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], opened1));

      // First run — file is new, should be read and written
      const reports1 = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );
      expect(opened1).toEqual([physicalPath]);
      expect(reports1[0]?.sessionsWritten).toBe(1);

      // Second run — same mtime+size, manifest gate suppresses read entirely
      const opened2: string[] = [];
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], opened2));

      const reports2 = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );
      expect(opened2).toEqual([]);
      expect(reports2[0]?.sessionsSeen).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("changed mtime causes file to be re-processed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "session-b.jsonl");
    writeFileSync(physicalPath, '{"id":"session-b"}\n', "utf8");

    const s = session("manifest-changed-b", physicalPath);
    const server = startServer("tok");

    try {
      const opened1: string[] = [];
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], opened1));

      await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );
      expect(opened1).toEqual([physicalPath]);

      // Simulate a file change: write new content (updates mtime+size)
      writeFileSync(physicalPath, '{"id":"session-b","extra":"data"}\n', "utf8");

      const opened2: string[] = [];
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], opened2));

      const reports2 = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );
      // File was re-read because mtime/size changed
      expect(opened2).toEqual([physicalPath]);
      expect(reports2[0]?.sessionsWritten).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("--force bypasses manifest and re-processes all files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "session-c.jsonl");
    writeFileSync(physicalPath, '{"id":"session-c"}\n', "utf8");

    const s = session("manifest-force-c", physicalPath);
    const server = startServer("tok");

    try {
      // First run — populate manifest
      const opened1: string[] = [];
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], opened1));
      await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );
      expect(opened1).toEqual([physicalPath]);

      // Verify manifest was written
      const savedManifest = loadManifest(manifestFilePath);
      expect(savedManifest[physicalPath]).toBeDefined();

      // --force run — shouldReadFile not provided, all files opened
      const opened2: string[] = [];
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], opened2));
      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "tok", force: true, manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );
      // File must be read despite manifest having a matching entry
      expect(opened2).toEqual([physicalPath]);
      expect(reports[0]?.sessionsWritten).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("manifest is persisted after successful ingest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "session-d.jsonl");
    writeFileSync(physicalPath, '{"id":"session-d"}\n', "utf8");

    const s = session("manifest-persist-d", physicalPath);
    const server = startServer("tok");

    try {
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], []));
      await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );

      const saved = loadManifest(manifestFilePath);
      expect(saved[physicalPath]).toBeDefined();
      const st = statSync(physicalPath);
      expect(saved[physicalPath]?.mtimeMs).toBe(st.mtimeMs);
      expect(saved[physicalPath]?.size).toBe(st.size);
    } finally {
      server.stop(true);
    }
  });
});
