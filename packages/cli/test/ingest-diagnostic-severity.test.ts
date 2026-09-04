import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { sessionIdFor } from "../src/adapters/common";
import { ClaudeSessionId } from "../src/core/identity";
import {
  DIAGNOSTIC_MESSAGE_MAX_BYTES,
  DIAGNOSTIC_TRUNCATION_MARKER,
  diagnosticSeverity,
  truncateDiagnosticMessage,
} from "../src/core/schemas";
import type { IngestReport } from "../src/ingest";
import { ingestRemote, loadManifest } from "../src/ingest";
import { ingestFailureError } from "../src/ingest-report";
import { NOW, appendText, buildFixtureFor, writeJsonLines } from "./adapter-test-harness";

// ---------------------------------------------------------------------------
// Fixtures
//
// The class-1 hostile fixtures are real unmodeled Claude attachment subtypes
// measured from the live corpus. `classifyAttachment` drops each one with the
// named diagnostic `claude.attachment.unknown_subtype` — correctly. What used to
// follow is the bug under test: the adapter stamped `status: "error"` on the
// drop, the ingest engine promoted it to a session failure, and one failed
// session blocked manifest persistence for the entire provider walk, so every
// Claude session re-parsed on every tick forever.
// ---------------------------------------------------------------------------

const HOSTILE_DIR = join(import.meta.dir, "fixtures", "hostile");

/** Every class-1 fixture: an attachment subtype absent from ATTACHMENT_VERDICT. */
const UNKNOWN_ATTACHMENT_FIXTURES = [
  "claude-attachment-total-tokens-reminder.jsonl",
  "claude-attachment-mcp-instructions-delta.jsonl",
  "claude-attachment-hook-system-message.jsonl",
  "claude-attachment-hook-additional-context.jsonl",
  "claude-attachment-auto-mode.jsonl",
  "claude-attachment-mcp-instr.jsonl",
] as const;

const UNKNOWN_ATTACHMENT_DIAGNOSTIC = "claude.attachment.unknown_subtype";

const hostileLines = (): readonly string[] =>
  UNKNOWN_ATTACHMENT_FIXTURES.flatMap((name) =>
    readFileSync(join(HOSTILE_DIR, name), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0),
  );

const FIXTURE_PROJECT_DIR = ["projects", "-fixture-quasar"] as const;
const SECOND_SESSION_UUID = "aaaa1111-0001-4001-8001-000000000062";
const OVERSIZE_SESSION_UUID = "aaaa1111-0001-4001-8001-000000000063";

const claudeSessionId = (uuid: string) => sessionIdFor("claude", ClaudeSessionId(uuid));

const healthySessionRecords = (uuid: string): readonly unknown[] => [
  {
    uuid: `${uuid}-user-1`,
    sessionId: uuid,
    cwd: "/fixture/quasar",
    timestamp: NOW,
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "fixture user turn" }] },
  },
  {
    uuid: `${uuid}-assistant-1`,
    parentUuid: `${uuid}-user-1`,
    sessionId: uuid,
    timestamp: NOW,
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "fixture assistant turn" }] },
  },
];

const writeClaudeSession = (root: string, uuid: string, extra: readonly unknown[] = []): string => {
  const path = join(root, ...FIXTURE_PROJECT_DIR, `${uuid}.jsonl`);
  writeJsonLines(path, [...healthySessionRecords(uuid), ...extra]);
  return path;
};

/**
 * A record whose decode failure renders the offending value inline. Effect's
 * TreeFormatter prints "Expected string, actual {...}", so this one line yields
 * a ~60 KB diagnostic message — the mechanism that grew the daemon log to 9 GB
 * once a real session-sized value landed in it.
 */
const oversizeDecodeFailureRecord = (uuid: string) => ({
  uuid: `${uuid}-oversize`,
  sessionId: uuid,
  timestamp: NOW,
  type: "user",
  message: { role: { blob: "y".repeat(60_000) }, content: [{ type: "text", text: "x" }] },
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];
const previousClaudeRoot = process.env.QUASAR_CLAUDE_ROOT;

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousClaudeRoot === undefined) delete process.env.QUASAR_CLAUDE_ROOT;
  else process.env.QUASAR_CLAUDE_ROOT = previousClaudeRoot;
});

/** Real claude adapter over a temp root, with the healthy harness session in it. */
const claudeRoot = (): { readonly root: string; readonly primaryPath: string } => {
  const root = mkdtempSync(join(tmpdir(), "quasar-diagnostic-severity-"));
  tempRoots.push(root);
  const fixture = buildFixtureFor("claude", root);
  process.env.QUASAR_CLAUDE_ROOT = root;
  return { root, primaryPath: fixture.primaryPath };
};

interface ServerState {
  /** Mapped sessionIds the server must reject with a non-retryable HTTP 400. */
  readonly rejected: Set<string>;
  /** Error body the server returns for a rejected session. */
  rejectMessage: string;
  readonly probes: string[];
  readonly writes: string[];
}

const startServer = (state: ServerState) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/ingest/run") return Response.json({ ok: true, data: {} });
      if (pathname === "/ingest/fingerprint") {
        const body = await request.json() as { readonly probe: { readonly sessionId: string } };
        state.probes.push(body.probe.sessionId);
        return Response.json({ ok: true, data: { unchanged: false } });
      }
      if (pathname === "/ingest/session") {
        const body = await request.json() as {
          readonly session: {
            readonly session: { readonly sessionId: string };
            readonly messages: readonly unknown[];
            readonly toolCalls: readonly unknown[];
          };
        };
        const sessionId = body.session.session.sessionId;
        state.writes.push(sessionId);
        if (state.rejected.has(sessionId)) {
          return Response.json({ ok: false, error: { message: state.rejectMessage } }, { status: 400 });
        }
        return Response.json({
          ok: true,
          data: {
            outcome: {
              sessionId,
              status: "ok",
              messagesWritten: body.session.messages.length,
              toolCallsWritten: body.session.toolCalls.length,
              jobsEnqueued: 1,
            },
          },
        });
      }
      return Response.json({ ok: false, error: { message: "not found" } }, { status: 404 });
    },
  });

const serverState = (): ServerState => ({
  rejected: new Set<string>(),
  rejectMessage: "configured write rejection",
  probes: [],
  writes: [],
});

const diagnosticNamed = (report: IngestReport, name: string) =>
  report.diagnostics.find((diagnostic) => diagnostic.name === name);

const byteLength = (value: string) => new TextEncoder().encode(value).length;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("adapter diagnostic severity", () => {
  test("derives severity from status when an adapter does not state one", () => {
    expect(diagnosticSeverity({ status: "error" })).toBe("error");
    expect(diagnosticSeverity({ status: "unsupported" })).toBe("info");
    expect(diagnosticSeverity({ status: "available" })).toBe("info");
    expect(diagnosticSeverity({ status: "error", severity: "warning" })).toBe("warning");
  });

  test("caps a message on a code-point boundary and marks the cut", () => {
    const short = "claude.attachment.unknown_subtype for a.jsonl";
    expect(truncateDiagnosticMessage(short)).toBe(short);

    // 3-byte code points: a byte-blind cut would land mid-sequence and decode
    // to U+FFFD. The cap is in BYTES, so the kept prefix must still be whole.
    const multiByte = "字".repeat(DIAGNOSTIC_MESSAGE_MAX_BYTES);
    const cut = truncateDiagnosticMessage(multiByte);
    expect(cut).toContain(DIAGNOSTIC_TRUNCATION_MARKER);
    expect(cut).not.toContain("�");
    const kept = cut.slice(0, cut.indexOf(DIAGNOSTIC_TRUNCATION_MARKER));
    expect(byteLength(kept)).toBeLessThanOrEqual(DIAGNOSTIC_MESSAGE_MAX_BYTES);
    expect(kept).toBe("字".repeat(Math.floor(DIAGNOSTIC_MESSAGE_MAX_BYTES / 3)));
  });
});

describe("ingest with benign record-level drops", () => {
  test("unknown attachment subtypes keep the run green, the session written, and the manifest persisted", async () => {
    const { root, primaryPath } = claudeRoot();
    const lines = hostileLines();
    appendText(primaryPath, `${lines.join("\n")}\n`);
    const manifestPath = join(root, "ingest-manifest.json");
    const state = serverState();
    const server = startServer(state);

    try {
      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath },
        `http://127.0.0.1:${server.port}`,
      );
      const report = reports[0]!;

      // Green: no failed session, no command-level failure.
      expect(ingestFailureError(reports)).toBeUndefined();
      expect(report.sessionsFailed).toBe(0);
      expect(report.failures).toEqual([]);
      expect(report.sessionsWritten).toBe(1);

      // Named and surfaced, not silent — one row per distinct diagnostic.
      const dropped = diagnosticNamed(report, UNKNOWN_ATTACHMENT_DIAGNOSTIC);
      expect(dropped).toBeDefined();
      expect(dropped?.severity).toBe("warning");
      expect(dropped?.count).toBe(lines.length);
      expect(dropped?.sample).toContain(UNKNOWN_ATTACHMENT_DIAGNOSTIC);
      expect(report.diagnosticCounts.warning).toBe(lines.length);
      expect(report.diagnosticCounts.error).toBe(0);

      // Manifest entry persisted for the session's physical file.
      const stat = statSync(primaryPath);
      expect(loadManifest(manifestPath)[primaryPath]).toMatchObject({
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } finally {
      server.stop(true);
    }
  });

  test("a second ingest of an unchanged corpus reads, probes, and writes nothing", async () => {
    const { root, primaryPath } = claudeRoot();
    appendText(primaryPath, `${hostileLines().join("\n")}\n`);
    const manifestPath = join(root, "ingest-manifest.json");
    const state = serverState();
    const server = startServer(state);

    try {
      const first = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath },
        `http://127.0.0.1:${server.port}`,
      );
      expect(first[0]?.sessionsWritten).toBe(1);
      expect(state.writes).toHaveLength(1);

      const second = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath },
        `http://127.0.0.1:${server.port}`,
      );

      expect(second[0]?.sessionsSeen).toBe(0);
      expect(second[0]?.sessionsWritten).toBe(0);
      expect(second[0]?.sessionsFailed).toBe(0);
      // The stat gate suppresses the file read entirely: no probe, no write.
      expect(state.probes).toHaveLength(1);
      expect(state.writes).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("per-session manifest gate", () => {
  test("a failed session does not block a healthy sibling's manifest entry, and retries next run", async () => {
    const { root, primaryPath } = claudeRoot();
    appendText(primaryPath, `${hostileLines().join("\n")}\n`);
    const failingPath = writeClaudeSession(root, SECOND_SESSION_UUID);
    const manifestPath = join(root, "ingest-manifest.json");
    const failingSessionId = claudeSessionId(SECOND_SESSION_UUID);
    const state = serverState();
    state.rejected.add(failingSessionId);
    const server = startServer(state);

    try {
      const first = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath },
        `http://127.0.0.1:${server.port}`,
      );
      const firstReport = first[0]!;

      expect(firstReport.sessionsSeen).toBe(2);
      expect(firstReport.sessionsWritten).toBe(1);
      expect(firstReport.sessionsFailed).toBe(1);
      expect(firstReport.failures.map((failure) => failure.diagnostic)).toEqual(["remote_write_failed"]);
      expect(firstReport.failures[0]?.sessionId).toBe(failingSessionId);

      // The healthy sibling persists; the failed session's file does not.
      const afterFirst = loadManifest(manifestPath);
      expect(afterFirst[primaryPath]).toBeDefined();
      expect(afterFirst[failingPath]).toBeUndefined();

      // Next run: only the failed session is re-read, and it now succeeds.
      state.rejected.delete(failingSessionId);
      state.probes.length = 0;
      state.writes.length = 0;

      const second = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath },
        `http://127.0.0.1:${server.port}`,
      );
      const secondReport = second[0]!;

      expect(secondReport.sessionsSeen).toBe(1);
      expect(secondReport.sessionsWritten).toBe(1);
      expect(secondReport.sessionsFailed).toBe(0);
      expect(state.writes).toEqual([failingSessionId]);

      const afterSecond = loadManifest(manifestPath);
      expect(afterSecond[primaryPath]).toBeDefined();
      expect(afterSecond[failingPath]).toBeDefined();
    } finally {
      server.stop(true);
    }
  });
});

describe("diagnostic payload cap", () => {
  test("no adapter diagnostic message ships a serialized record", async () => {
    const { root } = claudeRoot();
    const oversizePath = writeClaudeSession(root, OVERSIZE_SESSION_UUID, [
      oversizeDecodeFailureRecord(OVERSIZE_SESSION_UUID),
    ]);
    expect(statSync(oversizePath).size).toBeGreaterThan(60_000);
    const manifestPath = join(root, "ingest-manifest.json");
    const state = serverState();
    const server = startServer(state);

    try {
      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath },
        `http://127.0.0.1:${server.port}`,
      );
      const report = reports[0]!;

      const decodeFailure = diagnosticNamed(report, "claude.user.decode_failed");
      expect(decodeFailure).toBeDefined();
      expect(decodeFailure?.severity).toBe("warning");
      expect(decodeFailure?.sample).toContain(DIAGNOSTIC_TRUNCATION_MARKER);
      // The uncapped message was ~60 KB — the whole offending record inline.
      expect(byteLength(decodeFailure?.sample ?? "")).toBeLessThan(statSync(oversizePath).size / 10);

      for (const diagnostic of report.diagnostics) {
        expect(byteLength(diagnostic.sample)).toBeLessThanOrEqual(DIAGNOSTIC_MESSAGE_MAX_BYTES + 128);
      }
    } finally {
      server.stop(true);
    }
  });

  test("a failure error from the server is capped before it reaches the report", async () => {
    const { root } = claudeRoot();
    const manifestPath = join(root, "ingest-manifest.json");
    const state = serverState();
    state.rejectMessage = `serialized session: ${"z".repeat(200_000)}`;
    const server = startServer(state);

    try {
      // Reject the harness session: its mapped id is derived the same way.
      const harnessSessionId = claudeSessionId("aaaa1111-0001-4001-8001-000000000061");
      state.rejected.add(harnessSessionId);

      const reports = await ingestRemote(
        { provider: "claude", ingestToken: "tok", manifestPath },
        `http://127.0.0.1:${server.port}`,
      );
      const report = reports[0]!;

      expect(report.sessionsFailed).toBe(1);
      const failure = report.failures[0]!;
      expect(failure.diagnostic).toBe("remote_write_failed");
      expect(failure.error).toContain(DIAGNOSTIC_TRUNCATION_MARKER);
      expect(byteLength(failure.error)).toBeLessThanOrEqual(DIAGNOSTIC_MESSAGE_MAX_BYTES + 128);
      for (const outcome of report.outcomes) {
        expect(byteLength(outcome.detail ?? "")).toBeLessThanOrEqual(DIAGNOSTIC_MESSAGE_MAX_BYTES + 128);
      }
    } finally {
      server.stop(true);
    }
  });
});
