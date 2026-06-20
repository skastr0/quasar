import { describe, expect, test } from "bun:test";

import { ingestFailureError, ingestReportPayload } from "../src/ingest-report";
import type { IngestReport } from "../../local-server/src/ingest";

const report = (sessionsFailed: number): IngestReport => ({
  provider: "codex",
  sessionsSeen: 2,
  sessionsWritten: sessionsFailed === 0 ? 2 : 1,
  sessionsSkipped: 0,
  sessionsFailed,
  messagesWritten: 3,
  toolCallsWritten: 4,
  jobsEnqueued: 5,
  searchDocuments: {
    total: 3,
    semanticEligible: 3,
    ignored: 0,
  },
  outcomes: [],
  failures: sessionsFailed === 0
    ? []
    : [{ sessionId: "session-a", diagnostic: "remote_write_failed", error: "socket closed" }],
  durationMs: 10,
});

describe("ingest report helpers", () => {
  test("classifies any failed session as a command failure", () => {
    const failure = ingestFailureError([report(1)]);

    expect(failure).toBeDefined();
    expect(failure?.name).toBe("IngestFailedError");
    expect(failure?.message).toBe("quasar ingest failed for 1 session");
    expect(failure?.details.reports[0]?.failures[0]?.diagnostic).toBe("remote_write_failed");
  });

  test("preserves successful reports as summary payloads", () => {
    expect(ingestFailureError([report(0)])).toBeUndefined();
    expect(ingestReportPayload([report(0)], true)).toMatchObject({
      reports: [{ provider: "codex", sessionsFailed: 0 }],
    });
  });
});
