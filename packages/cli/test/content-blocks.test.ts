import { describe, expect, it } from "bun:test";

import { ClaudeSessionId } from "../src/core/identity";
import { contentBlocksFromNative, sessionIdFor } from "../src/adapters/common";

const sessionId = sessionIdFor("claude", ClaudeSessionId("test-session"));

const blockNativeType = (block: { metadata?: unknown }) =>
  typeof block.metadata === "object" && block.metadata !== null
    ? (block.metadata as Record<string, unknown>).nativeType
    : undefined;

describe("contentBlocksFromNative tool-payload containment", () => {
  it("marks children of array-content tool_result blocks as tool payload", () => {
    // The exact Claude shape that leaked in the QSR-055 fidelity proof: a
    // user-role event whose content is a tool_result with an ARRAY of text
    // children. Those children are tool payload, not conversation.
    const blocks = contentBlocksFromNative(sessionId, "evt", [
      {
        type: "tool_result",
        tool_use_id: "toolu_123",
        content: [
          { type: "text", text: "Async agent launched successfully. agentId: a2dae7d" },
          { type: "text", text: "second payload chunk" },
        ],
      },
    ]);

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(blockNativeType(block)).toBe("tool_result");
    }
  });

  it("marks deeply nested and bare-string tool_result children", () => {
    const blocks = contentBlocksFromNative(sessionId, "evt", [
      {
        type: "tool_result",
        content: ["bare string payload", { content: [{ type: "text", text: "nested" }] }],
      },
    ]);

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(blockNativeType(block)).toBe("tool_result");
    }
  });

  it("leaves conversational text blocks with their own nativeType", () => {
    const blocks = contentBlocksFromNative(sessionId, "evt", [
      { type: "text", text: "a real human sentence" },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blockNativeType(blocks[0]!)).toBe("text");
  });

  it("keeps tool_use input marked while sibling text stays conversational", () => {
    const blocks = contentBlocksFromNative(sessionId, "evt", [
      { type: "text", text: "let me run that" },
      { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls" } },
    ]);

    const conversational = blocks.filter((b) => blockNativeType(b) === "text");
    const toolMarked = blocks.filter((b) => blockNativeType(b) === "tool_use");
    expect(conversational).toHaveLength(1);
    expect(toolMarked.length).toBeGreaterThan(0);
  });
});
