import { describe, expect, test } from "vitest";

import { fuseMatches, messageContentHash, planSessionIndex, RRF_K } from "./searchPlan";

describe("planSessionIndex", () => {
  test("skips unchanged content hashes before embedding", () => {
    const text = "same message";
    const plan = planSessionIndex({
      currentMessages: [
        {
          sessionId: "s1",
          seq: 1,
          role: "user",
          projectKey: "p1",
          text,
        },
      ],
      existingRows: [
        {
          key: "s1:1:user",
          contentHash: messageContentHash(text),
        },
      ],
    });

    expect(plan.rowsToEmbed).toEqual([]);
    expect(plan.keysToDelete).toEqual([]);
    expect(plan.messagesReused).toBe(1);
  });

  test("deletes orphaned and stale keys while embedding only changed rows", () => {
    const plan = planSessionIndex({
      currentMessages: [
        {
          sessionId: "s1",
          seq: 1,
          role: "user",
          projectKey: "p1",
          text: "current text",
        },
      ],
      existingRows: [
        {
          key: "s1:1:user",
          contentHash: "old-hash",
        },
        {
          key: "s1:2:assistant",
          contentHash: "orphan-hash",
        },
      ],
    });

    expect(plan.keysToDelete).toEqual(["s1:1:user", "s1:2:assistant"]);
    expect(plan.rowsToEmbed.map((row) => row.key)).toEqual(["s1:1:user"]);
    expect(plan.messagesReused).toBe(0);
  });
});

describe("fuseMatches", () => {
  test("uses RRF k=60 and records text/vector ranks", () => {
    const fused = fuseMatches({
      textMatches: [{ key: "a" }, { key: "b" }],
      vectorMatches: [{ key: "b" }, { key: "c" }],
    });

    expect(fused[0]).toMatchObject({ key: "b", textRank: 2, vectorRank: 1 });
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
    const textOnly = fused.find((match) => match.key === "a");
    expect(textOnly).toMatchObject({ textRank: 1 });
    expect(textOnly).not.toHaveProperty("vectorRank");
    const vectorOnly = fused.find((match) => match.key === "c");
    expect(vectorOnly).toMatchObject({ vectorRank: 2 });
    expect(vectorOnly).not.toHaveProperty("textRank");
  });

  test("honors limit after rank fusion", () => {
    expect(
      fuseMatches({
        textMatches: [{ key: "a" }, { key: "b" }],
        vectorMatches: [{ key: "b" }, { key: "c" }],
        limit: 1,
      }).map((match) => match.key),
    ).toEqual(["b"]);
  });
});
