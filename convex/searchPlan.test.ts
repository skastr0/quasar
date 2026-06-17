import { describe, expect, test } from "vitest";

import {
  fuseMatches,
  lexicalOnlyPlanRows,
  messageContentHash,
  messageSearchKey,
  planSessionIndex,
  RRF_K,
  unembeddedContentHash,
} from "./searchPlan";

describe("planSessionIndex", () => {
  test("skips unchanged content hashes before embedding", () => {
    const text = "same message";
    const plan = planSessionIndex({
      currentChunks: [
        {
          sessionId: "s1",
          seq: 1,
          role: "user",
          projectKey: "p1",
          chunkIndex: 0,
          text,
        },
      ],
      existingRows: [
        {
          key: messageSearchKey({ sessionId: "s1", seq: 1, role: "user", chunkIndex: 0 }),
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
      currentChunks: [
        {
          sessionId: "s1",
          seq: 1,
          role: "user",
          projectKey: "p1",
          chunkIndex: 0,
          text: "current text",
        },
      ],
      existingRows: [
        {
          key: messageSearchKey({ sessionId: "s1", seq: 1, role: "user", chunkIndex: 0 }),
          contentHash: "old-hash",
        },
        {
          key: messageSearchKey({ sessionId: "s1", seq: 2, role: "assistant", chunkIndex: 0 }),
          contentHash: "orphan-hash",
        },
      ],
    });

    expect(plan.keysToDelete).toEqual([
      messageSearchKey({ sessionId: "s1", seq: 1, role: "user", chunkIndex: 0 }),
      messageSearchKey({ sessionId: "s1", seq: 2, role: "assistant", chunkIndex: 0 }),
    ]);
    expect(plan.rowsToEmbed.map((row) => row.key)).toEqual([
      messageSearchKey({ sessionId: "s1", seq: 1, role: "user", chunkIndex: 0 }),
    ]);
    expect(plan.messagesReused).toBe(0);
  });

  test("treats lexical-only hashes as reusable only when embedding is unavailable", () => {
    const text = "same message";
    const existingRows = [
      {
        key: messageSearchKey({ sessionId: "s1", seq: 1, role: "user", chunkIndex: 0 }),
        contentHash: unembeddedContentHash(messageContentHash(text)),
      },
    ];
    const currentChunks = [
      {
        sessionId: "s1",
        seq: 1,
        role: "user" as const,
        projectKey: "p1",
        chunkIndex: 0,
        text,
      },
    ];

    expect(
      planSessionIndex({
        currentChunks,
        existingRows,
      }).rowsToEmbed.map((row) => row.key),
    ).toEqual([messageSearchKey({ sessionId: "s1", seq: 1, role: "user", chunkIndex: 0 })]);
    expect(
      planSessionIndex({
        currentChunks,
        existingRows: lexicalOnlyPlanRows(existingRows),
      }).rowsToEmbed,
    ).toEqual([]);
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
