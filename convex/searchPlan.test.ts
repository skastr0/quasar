import { describe, expect, test } from "vitest";

import { messageContentHash, planSessionIndex } from "./searchPlan";

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
