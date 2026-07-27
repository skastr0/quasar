import { describe, expect, test } from "bun:test";

import { messagesQuery } from "../src/query-spec";

describe("messagesQuery", () => {
  test("builds an unfiltered cross-session scan", () => {
    const spec = messagesQuery();

    expect(spec.kind).toBe("messages");
    if (spec.kind === "messages") {
      expect(spec.filters).toEqual({});
      expect(spec.page).toEqual({ limit: 100 });
    }
  });

  test("preserves every corpus, time, and lineage filter", () => {
    const filters = {
      sessionId: "codex:child-session",
      projectKey: "quasar",
      providers: ["codex", "claude"],
      role: "user",
      agentName: "codex",
      agentRole: "builder",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      messageAfter: "2026-07-01T00:00:00.000Z",
      messageBefore: "2026-08-01T00:00:00.000Z",
      sessionStartedAfter: "2026-06-01T00:00:00.000Z",
      sessionStartedBefore: "2026-08-01T00:00:00.000Z",
      rootsOnly: true,
      lineageRootSessionId: "codex:root-session",
    } as const;
    const spec = messagesQuery({ filters });

    expect(spec.kind).toBe("messages");
    if (spec.kind === "messages") {
      expect(JSON.parse(JSON.stringify(spec.filters))).toEqual(filters);
    }
  });

  test("keeps the existing helper session id input as an optional alias", () => {
    const spec = messagesQuery({ sessionId: "codex:one-session" });

    expect(spec.kind).toBe("messages");
    if (spec.kind === "messages") {
      expect(JSON.parse(JSON.stringify(spec.filters))).toEqual({
        sessionId: "codex:one-session",
      });
    }
  });

  test("rejects inverted time ranges before transport", () => {
    expect(() => messagesQuery({
      filters: {
        messageAfter: "2026-08-01T00:00:00.000Z",
        messageBefore: "2026-07-01T00:00:00.000Z",
      },
    })).toThrow();
    expect(() => messagesQuery({
      filters: {
        sessionStartedAfter: "2026-08-01T00:00:00.000Z",
        sessionStartedBefore: "2026-07-01T00:00:00.000Z",
      },
    })).toThrow();
  });
});
