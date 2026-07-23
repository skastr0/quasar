import { describe, expect, test } from "bun:test";

import { QUERY_PROTOCOL_VERSION } from "@skastr0/quasar-protocol";

import { runQuery } from "../src/query-client";

const sessionsQuery = {
  protocolVersion: QUERY_PROTOCOL_VERSION,
  kind: "sessions",
  projection: {
    detail: "summary",
    fields: ["sessionId"],
  },
  page: { limit: 1 },
} as const;

describe("query resource transport", () => {
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
