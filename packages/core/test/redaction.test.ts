import { describe, expect, test } from "vitest";

import { compactText } from "../src/adapters/common";
import { sanitizeIngestBatchForTransport, redactSensitive } from "../src/redaction";

describe("redaction", () => {
  test("strips encrypted native payload fields before transport and indexing", () => {
    const payload = {
      type: "reasoning",
      summary: [],
      encrypted_content: "gAAAAABpxgVW-secret-ciphertext",
      nested: {
        encryptedContent: "another-secret-ciphertext",
        ciphertext: "opaque",
      },
    };

    expect(redactSensitive(payload)).toEqual({
      type: "reasoning",
      summary: [],
      encrypted_content: "[redacted]",
      nested: {
        encryptedContent: "[redacted]",
        ciphertext: "[redacted]",
      },
    });
    expect(compactText(payload)).not.toContain("gAAAAABpxgVW");
    expect(compactText(payload)).not.toContain("another-secret-ciphertext");
    expect(compactText(payload)).not.toContain("encrypted_content");
    expect(compactText(payload)).not.toContain("[redacted]");
  });

  test("omits binary-like output from compact search text", () => {
    const binaryOutput = `${"\u0000".repeat(32)}${"\ufffd".repeat(32)}mach-o`;
    expect(compactText(binaryOutput.repeat(8))).toBe("[binary output omitted]");
    expect(compactText("\\u0000".repeat(80))).toBe("[binary output omitted]");
  });

  test("redacts string contentText before transport", () => {
    const googleKeyFixture = `AIza${"S".repeat(24)}`;
    const batch = sanitizeIngestBatchForTransport({
      protocolVersion: "quasar.ingest/v1",
      machine: { machineId: "machine:test" },
      sourceRoots: [],
      diagnostics: [],
      generatedAt: "2026-06-04T00:00:00.000Z",
      sessions: [
        {
          id: "session:test",
          nativeSessionId: "native:test",
          provider: "codex",
          agentName: "codex",
          machineId: "machine:test",
          projectIdentity: {
            projectIdentityKey: "path:test",
            displayName: "test",
            confidence: "low",
            signals: [],
          },
          sourceRoot: "/tmp",
          sourcePath: "/tmp/session.jsonl",
          events: [
            {
              id: "event:test",
              sessionId: "session:test",
              sequence: 0,
              machineId: "machine:test",
              provider: "codex",
              agentName: "codex",
              projectIdentityKey: "path:test",
              role: "assistant",
              kind: "message",
              contentText: `Bearer should-not-leak ${googleKeyFixture}`,
              content: `Bearer should-not-leak ${googleKeyFixture}`,
              contentBlocks: [],
              rawReference: { sourcePath: "/tmp/session.jsonl" },
            },
          ],
          toolCalls: [],
          sessionEdges: [],
          usageRecords: [],
          artifacts: [],
        },
      ],
    });

    const [event] = batch.sessions[0]!.events;
    expect(event.contentText).toContain("Bearer [redacted]");
    expect(event.contentText).not.toContain("should-not-leak");
    expect(event.contentText).not.toContain("AIza");
    expect(event.content).toContain("Bearer [redacted]");
  });

  test("redacts common free-text secret shapes", () => {
    const githubTokenFixture = `ghp_${"1234567890abcdef".repeat(2)}1234`;
    const awsKeyFixture = `AKIA${"1234567890ABCDEF"}`;
    const jwtFixture = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "signature"].join(".");
    const passwordFixture = ["pass", "w0rd"].join("");
    const databaseUrlFixture = `DATABASE_URL=postgres://user:${passwordFixture}@example.com/db`;
    const privateKeyFixture = [
      ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "),
      "abc",
      ["-----END OPENSSH", "PRIVATE KEY-----"].join(" "),
    ].join("\n");
    const text = [
      githubTokenFixture,
      awsKeyFixture,
      jwtFixture,
      databaseUrlFixture,
      privateKeyFixture,
    ].join("\n");

    const redacted = redactSensitive(text) as string;
    expect(redacted).not.toContain("ghp_");
    expect(redacted).not.toContain("AKIA");
    expect(redacted).not.toContain("eyJhbGci");
    expect(redacted).not.toContain(passwordFixture);
    expect(redacted).not.toContain("abc");
    expect(redacted).toContain("[redacted]");
    expect(redactSensitive("return data.password === data.confirmPassword")).toBe(
      "return data.password === data.confirmPassword",
    );
  });
});
