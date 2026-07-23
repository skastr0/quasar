import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NormalizedSession } from "../src/core/schemas";
import { afterEach, describe, expect, test } from "bun:test";

import { adaptersByProvider } from "../src/adapters/registry";
import type { AdapterDiscoverOptions, SessionAdapter } from "../src/adapters/types";
import { ingestRemote, loadManifest } from "../src/ingest";
import { NORMALIZATION_VERSION } from "../src/normalization-version";

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
  executionContexts: [],
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
      let fileStat: ReturnType<typeof statSync>;
      try {
        fileStat = statSync(physicalPath);
        if (opts.shouldReadFile?.(physicalPath, fileStat) === false) {
          // Manifest says skip — no content read
          continue;
        }
      } catch {
        // file missing — skip
        continue;
      }
      opened.push(physicalPath);
      const fingerprint = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
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

/** Shared-DB adapter: one stat-gated file, many session-specific fingerprints. */
const sharedDbAdapterFor = (
  sessions: readonly NormalizedSession[],
  physicalPath: string,
  opened: string[],
): SessionAdapter => ({
  id: "manifest-shared-db-fixture",
  provider: "claude",
  displayName: "Manifest Shared DB Fixture Adapter",
  stable: true,
  defaultRoot: () => undefined,
  read: async () => ({ sourceRoots: [], sessions: [...sessions], diagnostics: [] }),
  stream: async function* (opts: AdapterDiscoverOptions) {
    const fileStat = statSync(physicalPath);
    if (opts.shouldReadFile?.(physicalPath, fileStat) === false) return;
    opened.push(physicalPath);
    let accepted = 0;
    for (const s of sessions) {
      if (accepted >= (opts.limit ?? Number.POSITIVE_INFINITY)) break;
      const fingerprint = { tag: `session:${s.id}:${s.updatedAt}` };
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
          adapterId: "manifest-shared-db-fixture",
          rootPath: "/history",
          sourcePath: physicalPath,
          physicalPath,
        },
        fingerprint,
      };
      accepted += 1;
    }
  },
});

/** Minimal HTTP server that reports configured fingerprint state and accepts writes. */
const startServer = (
  token: string,
  options: {
    readonly unchanged?: boolean;
    readonly requests?: { probes: number; writes: number };
    readonly writeStatus?: number;
  } = {},
) => {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("x-quasar-ingest-token") !== token) {
        return Response.json({ ok: false, error: { message: "missing token" } }, { status: 401 });
      }
      const pathname = new URL(request.url).pathname;
      if (pathname === "/ingest/fingerprint") {
        if (options.requests !== undefined) options.requests.probes += 1;
        return Response.json({ ok: true, data: { unchanged: options.unchanged ?? false } });
      }
      if (pathname === "/ingest/session") {
        if (options.requests !== undefined) options.requests.writes += 1;
        if (options.writeStatus !== undefined) {
          return Response.json(
            { ok: false, error: { message: "configured write failure" } },
            { status: options.writeStatus },
          );
        }
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

  test("an older normalization version replays an unchanged file exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "session-versioned.jsonl");
    writeFileSync(physicalPath, '{"id":"session-versioned"}\n', "utf8");

    const s = session("manifest-versioned", physicalPath);
    const server = startServer("tok");

    try {
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], []));
      await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );
      const current = loadManifest(manifestFilePath);
      writeFileSync(manifestFilePath, JSON.stringify({
        ...current,
        [physicalPath]: { ...current[physicalPath], normalizationVersion: 1 },
      }));

      const opened: string[] = [];
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], opened));
      await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );

      expect(opened).toEqual([physicalPath]);
      expect(loadManifest(manifestFilePath)[physicalPath]?.normalizationVersion).toBe(NORMALIZATION_VERSION);
    } finally {
      server.stop(true);
    }
  });

  test("an unchanged current server refreshes a stale manifest before the next run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "session-server-current.jsonl");
    writeFileSync(physicalPath, '{"id":"session-server-current"}\n', "utf8");
    const fileStat = statSync(physicalPath);
    writeFileSync(manifestFilePath, JSON.stringify({
      [physicalPath]: {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        normalizationVersion: NORMALIZATION_VERSION - 1,
      },
    }));

    const requests = { probes: 0, writes: 0 };
    const server = startServer("tok", { unchanged: true, requests });
    const s = session("manifest-server-current", physicalPath);

    try {
      const openedFirst: string[] = [];
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], openedFirst));
      const first = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );

      expect(openedFirst).toEqual([physicalPath]);
      expect(first[0]?.sessionsSkipped).toBe(1);
      expect(requests).toEqual({ probes: 1, writes: 0 });
      expect(loadManifest(manifestFilePath)[physicalPath]).toEqual({
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        normalizationVersion: NORMALIZATION_VERSION,
      });

      const openedSecond: string[] = [];
      adaptersByProvider.set("claude", adapterFor([{ session: s, physicalPath }], openedSecond));
      const second = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );

      expect(openedSecond).toEqual([]);
      expect(second[0]?.sessionsSeen).toBe(0);
      expect(requests).toEqual({ probes: 1, writes: 0 });
    } finally {
      server.stop(true);
    }
  });

  test("a complete shared-DB run converges stat state from per-session probes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "shared.db");
    writeFileSync(physicalPath, "sqlite-fixture", "utf8");
    const fileStat = statSync(physicalPath);
    writeFileSync(manifestFilePath, JSON.stringify({
      [physicalPath]: {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        normalizationVersion: NORMALIZATION_VERSION - 1,
      },
    }));

    const requests = { probes: 0, writes: 0 };
    const server = startServer("tok", { unchanged: true, requests });
    const sessions = [
      session("manifest-shared-db-a", physicalPath),
      session("manifest-shared-db-b", physicalPath),
    ];

    try {
      const openedFirst: string[] = [];
      adaptersByProvider.set("claude", sharedDbAdapterFor(sessions, physicalPath, openedFirst));
      await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );

      expect(openedFirst).toEqual([physicalPath]);
      expect(requests).toEqual({ probes: 2, writes: 0 });
      expect(loadManifest(manifestFilePath)[physicalPath]?.normalizationVersion).toBe(NORMALIZATION_VERSION);

      const openedSecond: string[] = [];
      adaptersByProvider.set("claude", sharedDbAdapterFor(sessions, physicalPath, openedSecond));
      await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );

      expect(openedSecond).toEqual([]);
      expect(requests).toEqual({ probes: 2, writes: 0 });
    } finally {
      server.stop(true);
    }
  });

  test("a failed shared-DB run leaves its manifest stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "failed-shared.db");
    writeFileSync(physicalPath, "sqlite-fixture", "utf8");
    const fileStat = statSync(physicalPath);
    const staleVersion = NORMALIZATION_VERSION - 1;
    writeFileSync(manifestFilePath, JSON.stringify({
      [physicalPath]: {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        normalizationVersion: staleVersion,
      },
    }));

    const requests = { probes: 0, writes: 0 };
    const server = startServer("tok", { requests, writeStatus: 400 });

    try {
      adaptersByProvider.set(
        "claude",
        sharedDbAdapterFor([session("manifest-shared-db-failed", physicalPath)], physicalPath, []),
      );
      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );

      expect(reports[0]?.sessionsFailed).toBe(1);
      expect(requests).toEqual({ probes: 1, writes: 1 });
      expect(loadManifest(manifestFilePath)[physicalPath]?.normalizationVersion).toBe(staleVersion);
    } finally {
      server.stop(true);
    }
  });

  test("a limited unchanged run leaves unseen shared-DB state stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "limited-shared.db");
    writeFileSync(physicalPath, "sqlite-fixture", "utf8");
    const fileStat = statSync(physicalPath);
    const staleVersion = NORMALIZATION_VERSION - 1;
    writeFileSync(manifestFilePath, JSON.stringify({
      [physicalPath]: {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        normalizationVersion: staleVersion,
      },
    }));

    const requests = { probes: 0, writes: 0 };
    const server = startServer("tok", { unchanged: true, requests });

    try {
      adaptersByProvider.set(
        "claude",
        sharedDbAdapterFor([session("manifest-shared-db-limited", physicalPath)], physicalPath, []),
      );
      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "tok", limit: 1, manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );

      expect(reports[0]?.sessionsSkipped).toBe(1);
      expect(requests).toEqual({ probes: 1, writes: 0 });
      expect(loadManifest(manifestFilePath)[physicalPath]?.normalizationVersion).toBe(staleVersion);
    } finally {
      server.stop(true);
    }
  });

  test("a limited successful write leaves unseen shared-DB state stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-manifest-test-"));
    const manifestFilePath = join(dir, "ingest-manifest.json");
    const physicalPath = join(dir, "limited-write-shared.db");
    writeFileSync(physicalPath, "sqlite-fixture", "utf8");
    const fileStat = statSync(physicalPath);
    const staleVersion = NORMALIZATION_VERSION - 1;
    writeFileSync(manifestFilePath, JSON.stringify({
      [physicalPath]: {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        normalizationVersion: staleVersion,
      },
    }));

    const requests = { probes: 0, writes: 0 };
    const server = startServer("tok", { requests });
    const sessions = [
      session("manifest-shared-db-limited-write-a", physicalPath),
      session("manifest-shared-db-limited-write-b", physicalPath),
    ];

    try {
      adaptersByProvider.set("claude", sharedDbAdapterFor(sessions, physicalPath, []));
      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "tok", limit: 1, manifestPath: manifestFilePath },
        `http://127.0.0.1:${server.port}`,
      );

      expect(reports[0]?.sessionsWritten).toBe(1);
      expect(requests).toEqual({ probes: 1, writes: 1 });
      expect(loadManifest(manifestFilePath)[physicalPath]?.normalizationVersion).toBe(staleVersion);
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
      expect(saved[physicalPath]?.normalizationVersion).toBe(NORMALIZATION_VERSION);
    } finally {
      server.stop(true);
    }
  });
});
