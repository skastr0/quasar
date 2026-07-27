import { describe, expect, test } from "bun:test";

import { QUERY_PROTOCOL_VERSION } from "@skastr0/quasar-protocol";

import {
  queryResourceRequest,
  queryResponseFromResource,
  runQuery,
} from "../src/query-client";

const sessionsQuery = {
  protocolVersion: QUERY_PROTOCOL_VERSION,
  kind: "sessions",
  projection: {
    detail: "summary",
    fields: ["sessionId"],
  },
  page: { limit: 1 },
} as const;

const messageScanQuery = {
  protocolVersion: QUERY_PROTOCOL_VERSION,
  kind: "messages",
  filters: {
    projectKey: "project-a",
    providers: ["codex"],
    role: "user",
    messageAfter: "2026-07-01T00:00:00.000Z",
    messageBefore: "2026-08-01T00:00:00.000Z",
    sessionStartedAfter: "2026-06-01T00:00:00.000Z",
    sessionStartedBefore: "2026-08-01T00:00:00.000Z",
    rootsOnly: true,
    lineageRootSessionId: "codex:root",
  },
  projection: {
    detail: "summary",
    fields: [
      "messageId",
      "sessionId",
      "sequence",
      "role",
      "text",
      "timestamp",
    ],
  },
  page: { limit: 2 },
} as const;

describe("query resource transport", () => {
  test("carries filtered message scans through opaque snapshot keyset cursors", () => {
    const first = queryResponseFromResource({
      ok: true,
      command: "messages",
      data: {
        rows: [
          {
            messageId: "message-1",
            sessionId: "codex:root",
            sequence: 1,
            role: "user",
            text: "first",
            timestamp: "2026-07-01T00:01:00.000Z",
          },
          {
            messageId: "message-2",
            sessionId: "codex:root",
            sequence: 2,
            role: "user",
            text: "second",
            timestamp: "2026-07-01T00:02:00.000Z",
          },
        ],
        page: {
          limit: 2,
          snapshot: "process-a:7",
          next: { sessionId: "codex:root", sequence: 2 },
        },
      },
    }, messageScanQuery);

    expect(first.items.map((item) =>
      (item as { readonly messageId?: string }).messageId)).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(typeof first.page.nextCursor).toBe("string");

    const continued = {
      ...messageScanQuery,
      page: {
        limit: 2,
        cursor: first.page.nextCursor!,
      },
    };
    expect(queryResourceRequest(continued)).toEqual({
      path: "messages",
      params: {
        projectKey: "project-a",
        provider: "codex",
        role: "user",
        messageAfter: "2026-07-01T00:00:00.000Z",
        messageBefore: "2026-08-01T00:00:00.000Z",
        sessionStartedAfter: "2026-06-01T00:00:00.000Z",
        sessionStartedBefore: "2026-08-01T00:00:00.000Z",
        rootsOnly: "true",
        lineageRootSessionId: "codex:root",
        limit: 2,
        afterSessionId: "codex:root",
        afterSequence: 2,
        snapshot: "process-a:7",
      },
    });

    const second = queryResponseFromResource({
      ok: true,
      command: "messages",
      data: {
        rows: [{
          messageId: "message-3",
          sessionId: "codex:root-child",
          sequence: 1,
          role: "user",
          text: "third",
          timestamp: "2026-07-02T00:01:00.000Z",
        }],
        page: {
          limit: 2,
          snapshot: "process-a:7",
          next: null,
        },
      },
    }, continued);

    expect(second.items.map((item) =>
      (item as { readonly messageId?: string }).messageId)).toEqual(["message-3"]);
    expect(second.page.nextCursor).toBeUndefined();
  });

  test("validates message keys with SQLite binary string ordering", () => {
    const response = queryResponseFromResource({
      ok: true,
      command: "messages",
      data: {
        rows: [
          {
            messageId: "message-ascii",
            sessionId: "Z",
            sequence: 0,
            role: "user",
            text: "ascii",
            timestamp: null,
          },
          {
            messageId: "message-unicode",
            sessionId: "Å",
            sequence: 0,
            role: "user",
            text: "unicode",
            timestamp: null,
          },
        ],
        page: {
          limit: 2,
          snapshot: "corpus:7",
          next: { sessionId: "Å", sequence: 0 },
        },
      },
    }, messageScanQuery);

    expect(response.items.map((item) =>
      (item as { readonly sessionId?: string }).sessionId)).toEqual(["Z", "Å"]);
    expect(typeof response.page.nextCursor).toBe("string");
  });

  test("rejects message cursor drift and inconsistent server snapshots", () => {
    const first = queryResponseFromResource({
      ok: true,
      command: "messages",
      data: {
        rows: [{
          messageId: "message-1",
          sessionId: "codex:root",
          sequence: 1,
          role: "user",
          text: "first",
          timestamp: null,
        }],
        page: {
          limit: 2,
          snapshot: "process-a:7",
          next: { sessionId: "codex:root", sequence: 1 },
        },
      },
    }, messageScanQuery);
    const continued = {
      ...messageScanQuery,
      page: { limit: 2, cursor: first.page.nextCursor! },
    };

    expect(() => queryResourceRequest({
      ...continued,
      filters: { ...messageScanQuery.filters, role: "assistant" },
    })).toThrow("query cursor does not match the query shape");

    expect(() => queryResponseFromResource({
      ok: true,
      command: "messages",
      data: {
        rows: [{
          messageId: "message-2",
          sessionId: "codex:root",
          sequence: 2,
          role: "user",
          text: "second",
          timestamp: null,
        }],
        page: {
          limit: 2,
          snapshot: "process-a:8",
          next: null,
        },
      },
    }, continued)).toThrow("message resource page does not match the request");
  });

  test("retries Bun connection-refused and timeout failures with a fresh attempt budget", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(
          new Error("Unable to connect. Is the computer able to access the url?"),
          { code: "ConnectionRefused" },
        );
      }
      if (attempts === 2) {
        throw Object.assign(new Error("The operation timed out."), {
          name: "TimeoutError",
          code: 23,
        });
      }
      return Response.json({
        ok: true,
        command: "sessions",
        data: {
          rows: [],
          page: { limit: 1, offset: 0, nextOffset: null },
        },
      });
    };

    const result = await runQuery(sessionsQuery, {
      serverUrl: "http://127.0.0.1:7180",
      timeoutMs: 1_000,
      fetchImpl,
    });

    expect(attempts).toBe(3);
    expect(result.items).toEqual([]);
  });

  test("caps terminal transient failures at three attempts", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      throw Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
      });
    };

    await expect(runQuery(sessionsQuery, {
      serverUrl: "http://127.0.0.1:7180",
      timeoutMs: 1_000,
      fetchImpl,
    })).rejects.toMatchObject({
      name: "FetchTransportError",
      attempts: 3,
    });

    expect(attempts).toBe(3);
  });

  test("does not retry non-transient fetch failures", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      throw new Error("permission denied");
    };

    await expect(runQuery(sessionsQuery, {
      serverUrl: "http://127.0.0.1:7180",
      timeoutMs: 1_000,
      fetchImpl,
    })).rejects.toThrow("permission denied");

    expect(attempts).toBe(1);
  });
});
