import { describe, expect, test } from "bun:test";

import { compactText } from "../src/adapters/common";
import { redactSensitive } from "../src/core/redaction";

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
    // The machinery envelope (type: "reasoning") with no actual content
    // projects to undefined — no message row is created.
    expect(compactText(payload)).toBeUndefined();
    // Verify a payload with actual text content survives.
    const payloadWithText = {
      type: "reasoning",
      text: "actual content",
      encrypted_content: "gAAAAABpxgVW-secret-ciphertext",
    };
    expect(compactText(payloadWithText)).not.toContain("gAAAAABpxgVW");
    expect(compactText(payloadWithText)).not.toContain("encrypted_content");
    expect(compactText(payloadWithText)).toContain("actual content");
  });

  test("preserves control-character-dense text instead of discarding it by heuristic", () => {
    // No invented binary-detection budget: control characters normalize to
    // spaces and the content survives. The ingest boundary is the only line at
    // which provider garbage is rejected.
    const binaryOutput = `${"\u0000".repeat(32)}mach-o`;
    expect(compactText(binaryOutput.repeat(8))).toBe(
      Array.from({ length: 8 }, () => "mach-o").join(" "),
    );
    expect(compactText("\\u0000".repeat(80))).toBe("\\u0000".repeat(80));
  });

  test("redacts string content", () => {
    const googleKeyFixture = `AIza${"S".repeat(24)}`;
    const text = redactSensitive(`Bearer should-not-leak ${googleKeyFixture}`);

    expect(text).toContain("Bearer [redacted]");
    expect(text).not.toContain("should-not-leak");
    expect(text).not.toContain("AIza");
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
