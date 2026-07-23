import type { NormalizedSession } from "../src/core/schemas";
import { afterEach, describe, expect, test } from "bun:test";

import { adaptersByProvider } from "../src/adapters/registry";
import type { SessionAdapter } from "../src/adapters/types";
import { ingestRemote, postFingerprintProbe, postIngestRun, postMappedSession } from "../src/ingest";

const realClaudeAdapter = adaptersByProvider.get("claude");
afterEach(() => {
  if (realClaudeAdapter) adaptersByProvider.set("claude", realClaudeAdapter);
  else adaptersByProvider.delete("claude");
});

const session = (id = "session-a"): NormalizedSession => ({
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
  title: "Fixture session",
  startedAt: "2026-06-18T10:00:00.000Z",
  updatedAt: "2026-06-18T10:02:00.000Z",
  sourceRoot: "/history",
  sourcePath: `/history/${id}.jsonl`,
  events: [
    {
      id: `${id}:event-1`,
      sessionId: id,
      sequence: 0,
      timestamp: "2026-06-18T10:00:00.000Z",
      machineId: "machine-a",
      provider: "claude",
      agentName: "test-agent",
      projectIdentityKey: "project-a",
      role: "user",
      kind: "message",
      contentText: "hello from user",
      contentBlocks: [],
      rawReference: { sourcePath: `/history/${id}.jsonl` },
    },
    {
      id: `${id}:event-2`,
      sessionId: id,
      sequence: 1,
      timestamp: "2026-06-18T10:01:00.000Z",
      machineId: "machine-a",
      provider: "claude",
      agentName: "test-agent",
      projectIdentityKey: "project-a",
      role: "assistant",
      kind: "message",
      contentText: "hello from assistant",
      contentBlocks: [],
      rawReference: { sourcePath: `/history/${id}.jsonl` },
    },
  ],
  toolCalls: [
    {
      id: `${id}:tool-1`,
      sessionId: id,
      eventId: `${id}:event-tool`,
      machineId: "machine-a",
      provider: "claude",
      agentName: "test-agent",
      projectIdentityKey: "project-a",
      toolName: "shell_command",
      status: "ok",
      input: { command: "echo ok" },
      output: "ok",
      startedAt: "2026-06-18T10:02:00.000Z",
      completedAt: "2026-06-18T10:02:01.000Z",
    },
  ],
  sessionEdges: [],
  executionContexts: [],
  usageRecords: [],
  artifacts: [],
});

const fingerprintForSession = (item: NormalizedSession) => ({ tag: `fingerprint:${item.id}` });

const adapterFor = (sessions: readonly NormalizedSession[], options: { readonly onParse?: (sessionId: string) => void } = {}): SessionAdapter => ({
  id: "fixture-adapter",
  provider: "claude",
  displayName: "Fixture Adapter",
  stable: true,
  defaultRoot: () => undefined,
  read: async () => ({ sourceRoots: [], sessions: [...sessions], diagnostics: [] }),
  stream: async function* (discoverOptions) {
    for (const item of sessions) {
      const fingerprint = fingerprintForSession(item);
      if ((await discoverOptions.shouldParseSession?.({ sessionId: item.id, sourceFingerprint: JSON.stringify(fingerprint) })) === false) {
        continue;
      }
      options.onParse?.(item.id);
      yield { type: "session" as const, session: item, fingerprint };
    }
  },
});

const diagnosticAdapter = (): SessionAdapter => ({
  id: "diagnostic-adapter",
  provider: "claude",
  displayName: "Diagnostic Adapter",
  stable: true,
  defaultRoot: () => undefined,
  read: async () => ({
    sourceRoots: [],
    sessions: [],
    diagnostics: [{
      adapterId: "diagnostic-adapter",
      provider: "claude",
      status: "error",
      parserConfidence: "documented",
      rootPath: "/history",
      message: "fixture adapter diagnostic",
      details: { diagnostic: "fixture.adapter.boundary", sourcePath: "/history/bad.jsonl" },
    }],
  }),
  stream: async function* () {
    yield {
      type: "diagnostic" as const,
      diagnostic: {
        adapterId: "diagnostic-adapter",
        provider: "claude" as const,
        status: "error" as const,
        parserConfidence: "documented" as const,
        rootPath: "/history",
        message: "fixture adapter diagnostic",
        details: { diagnostic: "fixture.adapter.boundary", sourcePath: "/history/bad.jsonl" },
      },
    };
  },
});

const throwingAdapter = (): SessionAdapter => ({
  id: "throwing-adapter",
  provider: "claude",
  displayName: "Throwing Adapter",
  stable: true,
  defaultRoot: () => undefined,
  read: async () => ({ sourceRoots: [], sessions: [], diagnostics: [] }),
  stream: async function* () {
    throw new Error("provider stream exploded");
  },
});

describe("ingestRemote", () => {
  test("remote ingest reports adapter error diagnostics as failures", async () => {
    adaptersByProvider.set("claude", diagnosticAdapter());
    const runs: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        if (request.headers.get("x-quasar-ingest-token") !== "token-a") return new Response(null, { status: 401 });
        if (new URL(request.url).pathname !== "/ingest/run") return new Response(null, { status: 404 });
        runs.push((await request.json() as { run: Record<string, unknown> }).run);
        return Response.json({ ok: true, data: {} });
      },
    });

    try {
      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "token-a" },
        `http://127.0.0.1:${server.port}`,
      );

      expect(reports[0]?.sessionsSeen).toBe(0);
      expect(reports[0]?.sessionsWritten).toBe(0);
      expect(reports[0]?.sessionsFailed).toBe(1);
      expect(reports[0]?.failures).toEqual([{
        sessionId: "/history/bad.jsonl",
        diagnostic: "fixture.adapter.boundary",
        error: "fixture adapter diagnostic",
      }]);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({ status: "running", sessionsSeen: 0 });
      expect(runs[1]).toMatchObject({ status: "failed", sessionsFailed: 1, completedAt: expect.any(String) });
      expect(runs[1]?.runId).toBe(runs[0]?.runId);
    } finally {
      server.stop(true);
    }
  });

  test("remote ingest retries transient server write failures", async () => {
    adaptersByProvider.set("claude", adapterFor([session("remote-retry")]));
    let writeAttempts = 0;
    const runs: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("x-quasar-ingest-token") !== "token-a") {
          return Response.json({ ok: false, error: { message: "missing token" } }, { status: 401 });
        }
        if (new URL(request.url).pathname === "/ingest/fingerprint") {
          return Response.json({ ok: true, data: { unchanged: false } });
        }
        if (new URL(request.url).pathname === "/ingest/run") {
          runs.push((await request.json() as { run: Record<string, unknown> }).run);
          return Response.json({ ok: true, data: {} });
        }
        writeAttempts += 1;
        if (writeAttempts === 1) {
          return Response.json({ ok: false, error: { message: "temporary write failure" } }, { status: 500 });
        }
        const payload = await request.json() as {
          readonly session: {
            readonly session: { readonly sessionId: string };
            readonly messages: readonly unknown[];
            readonly toolCalls: readonly unknown[];
          };
        };
        return Response.json({
          ok: true,
          data: {
            outcome: {
              sessionId: payload.session.session.sessionId,
              status: "ok",
              messagesWritten: payload.session.messages.length,
              toolCallsWritten: payload.session.toolCalls.length,
              jobsEnqueued: payload.session.messages.length + payload.session.toolCalls.length + 1,
            },
          },
        });
      },
    });

    try {
      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "token-a" },
        `http://127.0.0.1:${server.port}`,
      );

      expect(writeAttempts).toBe(2);
      expect(reports[0]?.sessionsWritten).toBe(1);
      expect(reports[0]?.sessionsFailed).toBe(0);
      expect(reports[0]?.messagesWritten).toBe(2);
      expect(reports[0]?.toolCallsWritten).toBe(1);
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({ status: "completed", sessionsSeen: 1, sessionsWritten: 1, sessionsFailed: 0 });
    } finally {
      server.stop(true);
    }
  });

  test("remote ingest retries an uncertain successful acknowledgement with a null JSON body", async () => {
    adaptersByProvider.set("claude", adapterFor([session("remote-null-ack")]));
    let writeAttempts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/ingest/fingerprint") {
          return Response.json({ ok: true, data: { unchanged: false } });
        }
        if (path === "/ingest/run") {
          return Response.json({ ok: true, data: {} });
        }
        writeAttempts += 1;
        if (writeAttempts === 1) return Response.json(null);
        const payload = await request.json() as {
          readonly session: {
            readonly session: { readonly sessionId: string };
            readonly messages: readonly unknown[];
            readonly toolCalls: readonly unknown[];
          };
        };
        return Response.json({
          ok: true,
          data: {
            outcome: {
              sessionId: payload.session.session.sessionId,
              status: "ok",
              messagesWritten: payload.session.messages.length,
              toolCallsWritten: payload.session.toolCalls.length,
              jobsEnqueued: payload.session.messages.length,
            },
          },
        });
      },
    });

    try {
      const reports = await ingestRemote(
        { provider: "claude" },
        `http://127.0.0.1:${server.port}`,
      );

      expect(writeAttempts).toBe(2);
      expect(reports[0]).toMatchObject({
        sessionsWritten: 1,
        sessionsFailed: 0,
      });
    } finally {
      server.stop(true);
    }
  });

  test("completed lifecycle acknowledgement uncertainty does not rewrite a successful provider run", async () => {
    adaptersByProvider.set("claude", adapterFor([session("completed-ack")]));
    const runs: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/ingest/fingerprint") return Response.json({ ok: true, data: { unchanged: false } });
        if (path === "/ingest/session") {
          const payload = await request.json() as { readonly session: { readonly session: { readonly sessionId: string } } };
          return Response.json({
            ok: true,
            data: { outcome: { sessionId: payload.session.session.sessionId, status: "ok", messagesWritten: 2, toolCallsWritten: 1, jobsEnqueued: 3 } },
          });
        }
        if (path === "/ingest/run") {
          const run = (await request.json() as { run: Record<string, unknown> }).run;
          runs.push(run);
          if (run.status === "completed") {
            return Response.json({ ok: false, error: { message: "terminal acknowledgement unavailable" } }, { status: 500 });
          }
          return Response.json({ ok: true, data: {} });
        }
        return new Response(null, { status: 404 });
      },
    });

    try {
      await expect(ingestRemote(
        { provider: "claude" },
        `http://127.0.0.1:${server.port}`,
      )).rejects.toThrow("terminal acknowledgement unavailable");

      expect(runs).toHaveLength(4);
      expect(runs.map((run) => run.status)).toEqual(["running", "completed", "completed", "completed"]);
      expect(runs.slice(1)).toEqual(runs.slice(1).map((run) => expect.objectContaining({
        status: "completed", sessionsSeen: 1, sessionsWritten: 1, sessionsSkipped: 0, sessionsFailed: 0,
      })));
      expect(new Set(runs.map((run) => run.runId))).toEqual(new Set([runs[0]?.runId]));
    } finally {
      server.stop(true);
    }
  });

  test("failed lifecycle acknowledgement does not mask the provider failure", async () => {
    adaptersByProvider.set("claude", throwingAdapter());
    const runs: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/ingest/run") return new Response(null, { status: 404 });
        const run = (await request.json() as { run: Record<string, unknown> }).run;
        runs.push(run);
        if (run.status === "failed") {
          return Response.json({ ok: false, error: { message: "failed-run ledger unavailable" } }, { status: 500 });
        }
        return Response.json({ ok: true, data: {} });
      },
    });

    try {
      await expect(ingestRemote(
        { provider: "claude" },
        `http://127.0.0.1:${server.port}`,
      )).rejects.toThrow("provider stream exploded");

      expect(runs).toHaveLength(4);
      expect(runs.map((run) => run.status)).toEqual(["running", "failed", "failed", "failed"]);
      expect(runs.slice(1)).toEqual(runs.slice(1).map((run) => expect.objectContaining({
        status: "failed", sessionsSeen: 0, sessionsWritten: 0, sessionsSkipped: 0, sessionsFailed: 1,
      })));
      expect(new Set(runs.map((run) => run.runId))).toEqual(new Set([runs[0]?.runId]));
    } finally {
      server.stop(true);
    }
  });

  test("remote ingest probes fingerprints before parsing unchanged sessions", async () => {
    const parsed: string[] = [];
    adaptersByProvider.set("claude", adapterFor([session("remote-skip")], { onParse: (sessionId) => parsed.push(sessionId) }));
    let probes = 0;
    let writes = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("x-quasar-ingest-token") !== "token-a") {
          return Response.json({ ok: false, error: { message: "missing token" } }, { status: 401 });
        }
        if (new URL(request.url).pathname === "/ingest/fingerprint") {
          probes += 1;
          return Response.json({ ok: true, data: { unchanged: true } });
        }
        if (new URL(request.url).pathname === "/ingest/run") {
          return Response.json({ ok: true, data: {} });
        }
        writes += 1;
        return Response.json({ ok: false, error: { message: "unexpected write" } }, { status: 500 });
      },
    });

    try {
      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "token-a" },
        `http://127.0.0.1:${server.port}`,
      );

      expect(probes).toBe(1);
      expect(writes).toBe(0);
      expect(parsed).toEqual([]);
      expect(reports[0]?.sessionsSeen).toBe(1);
      expect(reports[0]?.sessionsSkipped).toBe(1);
      expect(reports[0]?.sessionsWritten).toBe(0);
      expect(reports[0]?.sessionsFailed).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("remote lifecycle, fingerprint, and session writes honor the configured timeout", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async () => {
        await Bun.sleep(100);
        return Response.json({ ok: true, data: { unchanged: false } });
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const options = { ingestToken: "token-a", timeoutMs: 10 };
    try {
      await expect(postFingerprintProbe(base, { sessionId: "timeout-fingerprint", sourceFingerprint: "timeout" }, options)).rejects.toThrow();
      await expect(postIngestRun(base, {
        runId: "timeout-run", provider: "claude", status: "running", startedAt: new Date().toISOString(),
        sessionsSeen: 0, sessionsWritten: 0, sessionsSkipped: 0, sessionsFailed: 0,
      }, options)).rejects.toThrow();
      await expect(postMappedSession(base, {
        project: { projectKey: "timeout-project", displayName: "Timeout Project" },
        session: { sessionId: "timeout-session", projectKey: "timeout-project", provider: "claude", agentName: "claude", sourcePath: "/tmp/timeout", sourceFingerprint: "timeout", host: "timeout-host", identitySchemeVersion: 1, normalizationVersion: 1, messageCount: 0, toolCallCount: 0 },
        messages: [], toolCalls: [], events: [], usageRecords: [], sessionEdges: [], artifacts: [], executionContexts: [],
      }, options)).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });
});
