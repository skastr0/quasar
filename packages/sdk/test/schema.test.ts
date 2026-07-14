import { describe, it, expect } from "bun:test";
import { Effect, Schema } from "effect";
import * as Schemas from "../src/schema.js";

describe("SDK Schemas", () => {
  describe("Provider", () => {
    it("decodes valid providers", async () => {
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.Provider)("claude"));
      expect(result).toBe("claude");
    });

    it("rejects invalid providers", async () => {
      try {
        await Effect.runPromise(Schema.decodeUnknown(Schemas.Provider)("invalid"));
        expect.unreachable();
      } catch {
        // Expected
      }
    });
  });

  describe("ProjectRow", () => {
    it("decodes valid project row", async () => {
      const data = {
        projectKey: "my-project",
        displayName: "My Project",
        rawPath: "/path/to/project",
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.ProjectRow)(data));
      expect(result.projectKey).toBe("my-project");
      expect(result.displayName).toBe("My Project");
      expect(result.rawPath).toBe("/path/to/project");
    });

    it("decodes project row without rawPath", async () => {
      const data = {
        projectKey: "my-project",
        displayName: "My Project",
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.ProjectRow)(data));
      expect(result.projectKey).toBe("my-project");
      expect(result.rawPath).toBeUndefined();
    });

    it("round-trips project row", async () => {
      const data = {
        projectKey: "test",
        displayName: "Test Project",
      };
      const decoded = await Effect.runPromise(Schema.decodeUnknown(Schemas.ProjectRow)(data));
      const encoded = await Effect.runPromise(Schema.encodeUnknown(Schemas.ProjectRow)(decoded));
      expect(encoded).toEqual(data);
    });
  });

  describe("SessionRow", () => {
    it("decodes minimal valid session row", async () => {
      const data = {
        sessionId: "session-123",
        projectKey: "project-key",
        provider: "claude" as const,
        agentName: "agent",
        sourcePath: "/path",
        sourceFingerprint: "abc123",
        host: "localhost",
        identitySchemeVersion: 1,
        messageCount: 5,
        toolCallCount: 2,
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.SessionRow)(data));
      expect(result.sessionId).toBe("session-123");
      expect(result.messageCount).toBe(5);
    });

    it("decodes session row with optional fields", async () => {
      const data = {
        sessionId: "session-123",
        projectKey: "project-key",
        provider: "claude" as const,
        agentName: "agent",
        title: "My Session",
        startedAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        sourcePath: "/path",
        sourceFingerprint: "abc123",
        host: "localhost",
        identitySchemeVersion: 1,
        parentSessionId: "parent-session-id",
        messageCount: 5,
        toolCallCount: 2,
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.SessionRow)(data));
      expect(result.title).toBe("My Session");
      expect(result.parentSessionId).toBe("parent-session-id");
    });
  });

  describe("MessageRow", () => {
    it("decodes valid message row", async () => {
      const data = {
        sessionId: "session-123",
        seq: 0,
        role: "user" as const,
        text: "Hello world",
        projectKey: "project-key",
        contentHash: "abc123",
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.MessageRow)(data));
      expect(result.sessionId).toBe("session-123");
      expect(result.role).toBe("user");
      expect(result.text).toBe("Hello world");
    });

    it("accepts all message roles", async () => {
      for (const role of ["user", "assistant", "reasoning"] as const) {
        const data = {
          sessionId: "s",
          seq: 0,
          role,
          text: "text",
          projectKey: "p",
          contentHash: "h",
        };
        const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.MessageRow)(data));
        expect(result.role).toBe(role);
      }
    });
  });

  describe("ToolCallRow", () => {
    it("decodes valid tool call row", async () => {
      const data = {
        id: "tool-call-123",
        sessionId: "session-123",
        seq: 1,
        toolName: "read_file",
        inputText: '{"path":"/etc/passwd"}',
        outputText: "file contents...",
        projectKey: "project-key",
        provider: "claude" as const,
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.ToolCallRow)(data));
      expect(result.id).toBe("tool-call-123");
      expect(result.toolName).toBe("read_file");
    });
  });

  describe("SearchHit", () => {
    it("decodes valid search hit", async () => {
      const data = {
        key: "hit-123",
        score: 0.95,
        row: {
          key: "msg-key",
          sessionId: "s-123",
          seq: 0,
          role: "user" as const,
          projectKey: "p",
          provider: "claude" as const,
          text: "search result text",
          contentHash: "abc",
        },
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.SearchHit)(data));
      expect(result.key).toBe("hit-123");
      expect(result.score).toBe(0.95);
      expect(result.row.text).toBe("search result text");
    });
  });

  describe("Envelope", () => {
    it("decodes success envelope", async () => {
      const data = {
        ok: true,
        command: "projects",
        data: [{ projectKey: "p1", displayName: "Project 1" }],
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.Envelope)(data));
      expect(result.ok).toBe(true);
    });

    it("decodes error envelope", async () => {
      const data = {
        ok: false,
        route: "/projects",
        error: {
          type: "NotFound",
          message: "Project not found",
        },
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.Envelope)(data));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe("NotFound");
      }
    });

    it("rejects malformed envelope", async () => {
      try {
        await Effect.runPromise(Schema.decodeUnknown(Schemas.Envelope)({ ok: "maybe" }));
        expect.unreachable();
      } catch {
        // Expected
      }
    });
  });

  describe("IngestRunRow", () => {
    it("decodes ingest run with provider", async () => {
      const data = {
        runId: "run-123",
        provider: "claude",
        status: "completed" as const,
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T01:00:00Z",
        sessionsSeen: 100,
        sessionsWritten: 95,
        sessionsSkipped: 3,
        sessionsFailed: 2,
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.IngestRunRow)(data));
      expect(result.provider).toBe("claude");
      expect(result.status).toBe("completed");
    });

    it("decodes ingest run with 'all' provider", async () => {
      const data = {
        runId: "run-123",
        provider: "all",
        status: "running" as const,
        startedAt: "2024-01-01T00:00:00Z",
        sessionsSeen: 10,
        sessionsWritten: 0,
        sessionsSkipped: 0,
        sessionsFailed: 0,
      };
      const result = await Effect.runPromise(Schema.decodeUnknown(Schemas.IngestRunRow)(data));
      expect(result.provider).toBe("all");
    });
  });
});
