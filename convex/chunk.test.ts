import { describe, expect, test } from "vitest";

import { CHUNK_OVERLAP_TOKENS, CHUNK_SIZE_TOKENS, chunkMessage, chunkText } from "./chunk";

describe("chunkText", () => {
  test("returns one chunk for short text", () => {
    const chunks = chunkText("hello world");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("hello world");
    expect(chunks[0]?.chunkIndex).toBeUndefined();
  });

  test("splits long text into overlapping chunks within token budget", () => {
    // Roughly 2 tokens per number ("1000" -> ~1 token, plus space -> ~1).
    const words = Array.from({ length: 1000 }, (_, index) => String(index)).join(" ");
    const chunks = chunkText(words, CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_TOKENS);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(CHUNK_SIZE_TOKENS);
    }
  });

  test("empty input yields no chunks", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
  });

  test("merges a tiny trailing chunk into the previous chunk", () => {
    // Construct text with ~512 tokens, then a tiny tail.
    const body = Array.from({ length: 300 }, (_, index) => `word${index}`).join(" ");
    const tail = "a b c";
    const chunks = chunkText(`${body} ${tail}`, CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_TOKENS);
    const last = chunks[chunks.length - 1];
    expect(last?.text).toContain("word299");
    expect(last?.text).toContain("a b c");
  });
});

describe("chunkMessage", () => {
  test("assigns per-message chunk indices", () => {
    const chunks = chunkMessage({
      sessionId: "s1",
      seq: 3,
      role: "assistant",
      projectKey: "p1",
      text: "one two three",
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sessionId: "s1",
      seq: 3,
      role: "assistant",
      projectKey: "p1",
      chunkIndex: 0,
      text: "one two three",
    });
  });
});
