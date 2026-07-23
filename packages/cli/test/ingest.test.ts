import type { NormalizedSession } from "../src/core/schemas";
import { afterEach, describe, expect, test } from "bun:test";

import { adaptersByProvider } from "../src/adapters/registry";
import type { SessionAdapter } from "../src/adapters/types";
import { ingestRemote } from "../src/ingest";

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

describe("ingestRemote", () => {
  test("remote ingest reports adapter error diagnostics as failures", async () => {
    adaptersByProvider.set("claude", diagnosticAdapter());

    const reports = await ingestRemote(
      { provider: "claude", ingestToken: "token-a" },
      "http://127.0.0.1:1",
    );

    expect(reports[0]?.sessionsSeen).toBe(0);
    expect(reports[0]?.sessionsWritten).toBe(0);
    expect(reports[0]?.sessionsFailed).toBe(1);
    expect(reports[0]?.failures).toEqual([{
      sessionId: "/history/bad.jsonl",
      diagnostic: "fixture.adapter.boundary",
      error: "fixture adapter diagnostic",
    }]);
  });

  test("remote ingest retries transient server write failures", async () => {
    adaptersByProvider.set("claude", adapterFor([session("remote-retry")]));
    let writeAttempts = 0;
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
});
