/// <reference types="vite/client" />
/**
 * Embedding-surface batteries:
 *
 * 1. ROLE PURITY — the embedding pipeline's only read path into `messages`
 *    (`embeddableMessages`) is structurally restricted to the two
 *    conversation roles: the argument validator cannot express any other
 *    role, and the index walk returns nothing outside the requested role.
 *    The structural surface (tool payloads) has no read path here at all —
 *    pinned additionally by the convex-lint embedding-surface rule.
 * 2. EMBED-QUEUE STATE — pending derivation over ingest claim + fingerprints.
 * 3. PURE SEARCH SHAPING — embedding input format, content hash, RAG-result
 *    mapping, and standard RRF fusion (k = 60).
 */
import { convexTest, type TestConvex } from "convex-test";
import workpoolTest from "@convex-dev/workpool/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import {
  embeddingInputFor,
  fuseMatches,
  messageContentHash,
  messageEntryKey,
  RRF_K,
  semanticMatchesFromSearch,
} from "./quasarRag";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Quasar = TestConvex<typeof schema>;

process.env.GOOGLE_API_KEY = "";
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "";

const testConvex = () => {
  const t = convexTest(schema, modules);
  workpoolTest.register(t, "embeddingWorkpool");
  return t;
};

const PROJECT_KEY = "git:github.com/example/alpha";
const SESSION_ID = "claude:machine:test:emb1";
const RUN_ID = "run-embed-battery";

const seedSession = async (t: Quasar, options?: { commit?: boolean }) => {
  await t.mutation(api.quasar.beginSessionIngest, {
    sessionId: SESSION_ID,
    projectKey: PROJECT_KEY,
    provider: "claude",
    agentName: "claude-code",
    sourcePath: "/tmp/alpha/emb1.jsonl",
    sourceFingerprint: '{"size":10,"mtimeMs":20}',
    messageCount: 4,
    toolCallCount: 1,
    runId: RUN_ID,
  });
  await t.mutation(api.quasar.insertMessages, {
    runId: RUN_ID,
    messages: [
      { sessionId: SESSION_ID, seq: 0, role: "user", text: "alpha question", projectKey: PROJECT_KEY },
      { sessionId: SESSION_ID, seq: 1, role: "reasoning", text: "hidden thought", projectKey: PROJECT_KEY },
      { sessionId: SESSION_ID, seq: 1, role: "assistant", text: "bravo answer", projectKey: PROJECT_KEY },
      { sessionId: SESSION_ID, seq: 2, role: "user", text: "charlie follow-up", projectKey: PROJECT_KEY },
    ],
  });
  await t.mutation(api.quasar.insertToolCalls, {
    runId: RUN_ID,
    toolCalls: [
      {
        sessionId: SESSION_ID,
        seq: 1,
        toolName: "Bash",
        inputText: '{"command":"secret-payload"}',
        outputText: "tool-output-payload",
        projectKey: PROJECT_KEY,
        provider: "claude",
      },
    ],
  });
  if (options?.commit !== false) {
    await t.mutation(api.quasar.commitSessionIngest, { sessionId: SESSION_ID, runId: RUN_ID });
  }
};

const paginate = { numItems: 50, cursor: null };

// ---------------------------------------------------------------------------
// 1. Role purity
// ---------------------------------------------------------------------------

describe("embedding-surface role purity", () => {
  test("embeddableMessages returns only the requested conversation role", async () => {
    const t = testConvex();
    await seedSession(t);
    const users = await t.query(internal.embed.embeddableMessages, {
      sessionId: SESSION_ID,
      role: "user",
      paginationOpts: paginate,
    });
    expect(users.page.map((row) => row.seq)).toEqual([0, 2]);
    const assistants = await t.query(internal.embed.embeddableMessages, {
      sessionId: SESSION_ID,
      role: "assistant",
      paginationOpts: paginate,
    });
    expect(assistants.page.map((row) => row.text)).toEqual(["bravo answer"]);
    // The union of both walks misses exactly the non-conversation row: the
    // seeded session has 4 message rows; the embedding surface sees 3.
    expect(users.page.length + assistants.page.length).toBe(3);
    const texts = [...users.page, ...assistants.page].map((row) => row.text);
    expect(texts).not.toContain("hidden thought");
    expect(texts.join(" ")).not.toContain("payload");
  });

  test("the validator cannot express any role outside the conversation surface", async () => {
    const t = testConvex();
    await seedSession(t);
    for (const role of ["reasoning", "system", "tool"]) {
      await expect(
        t.query(internal.embed.embeddableMessages, {
          sessionId: SESSION_ID,
          // @ts-expect-error — the purity pin: this role is not expressible.
          role,
          paginationOpts: paginate,
        }),
      ).rejects.toThrow(/Validator error|does not match/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Embed-queue state
// ---------------------------------------------------------------------------

describe("embed queue and completion marking", () => {
  test("pending derivation: ingest claimed -> not pending; committed -> pending; embedding claimed -> not pending; marked -> not pending", async () => {
    const t = testConvex();
    await seedSession(t, { commit: false });
    const claimed = (await t.query(internal.embed.embedQueue, { paginationOpts: paginate })).page;
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ sessionId: SESSION_ID, ingestClaimed: true, pending: false });

    await t.mutation(api.quasar.commitSessionIngest, { sessionId: SESSION_ID, runId: RUN_ID });
    const committed = (await t.query(internal.embed.embedQueue, { paginationOpts: paginate })).page;
    expect(committed[0]).toMatchObject({
      ingestClaimed: false,
      embeddingClaimed: true,
      pending: false,
    });

    const claim = await t.mutation(internal.embed.claimSessionEmbedding, {
      sessionId: SESSION_ID,
    });
    expect(claim).toMatchObject({ claimed: false, reason: "already_claimed" });
    const queued = (await t.query(internal.embed.embedQueue, { paginationOpts: paginate })).page;
    expect(queued[0]).toMatchObject({ embeddingClaimed: true, pending: false });

    const marked = await t.mutation(internal.embed.markSessionEmbedded, {
      sessionId: SESSION_ID,
      sourceFingerprint: '{"size":10,"mtimeMs":20}',
    });
    expect(marked).toEqual({ marked: true });
    const embedded = (await t.query(internal.embed.embedQueue, { paginationOpts: paginate })).page;
    expect(embedded[0]).toMatchObject({ embeddingClaimed: false, pending: false });
  });

  test("claimSessionEmbedding is fingerprint-scoped and idempotent", async () => {
    const t = testConvex();
    expect(await t.mutation(internal.embed.claimSessionEmbedding, { sessionId: "nope" })).toEqual({
      claimed: false,
      reason: "missing",
    });

    await seedSession(t, { commit: false });
    expect(await t.mutation(internal.embed.claimSessionEmbedding, { sessionId: SESSION_ID })).toEqual({
      claimed: false,
      reason: "ingest_in_progress",
    });

    await t.mutation(api.quasar.commitSessionIngest, { sessionId: SESSION_ID, runId: RUN_ID });
    const first = await t.mutation(internal.embed.claimSessionEmbedding, { sessionId: SESSION_ID });
    expect(first).toMatchObject({
      claimed: false,
      reason: "already_claimed",
      sourceFingerprint: '{"size":10,"mtimeMs":20}',
    });
    const second = await t.mutation(internal.embed.claimSessionEmbedding, { sessionId: SESSION_ID });
    expect(second).toMatchObject({
      claimed: false,
      reason: "already_claimed",
      sourceFingerprint: '{"size":10,"mtimeMs":20}',
    });

    await t.mutation(internal.embed.markSessionEmbedded, {
      sessionId: SESSION_ID,
      sourceFingerprint: '{"size":10,"mtimeMs":20}',
    });
    expect(await t.mutation(internal.embed.claimSessionEmbedding, { sessionId: SESSION_ID })).toEqual({
      claimed: false,
      reason: "current",
      sourceFingerprint: '{"size":10,"mtimeMs":20}',
    });
  });

  test("markSessionEmbedded refuses missing, claimed, and superseded sessions", async () => {
    const t = testConvex();
    expect(
      await t.mutation(internal.embed.markSessionEmbedded, {
        sessionId: "nope",
        sourceFingerprint: "x",
      }),
    ).toEqual({ marked: false, reason: "missing" });

    await seedSession(t, { commit: false });
    expect(
      await t.mutation(internal.embed.markSessionEmbedded, {
        sessionId: SESSION_ID,
        sourceFingerprint: '{"size":10,"mtimeMs":20}',
      }),
    ).toEqual({ marked: false, reason: "ingest_in_progress" });

    await t.mutation(api.quasar.commitSessionIngest, { sessionId: SESSION_ID, runId: RUN_ID });
    expect(
      await t.mutation(internal.embed.markSessionEmbedded, {
        sessionId: SESSION_ID,
        sourceFingerprint: "stale-fingerprint",
      }),
    ).toEqual({ marked: false, reason: "superseded" });
  });

  test("sessionEmbedState reports fingerprints and the ingest claim", async () => {
    const t = testConvex();
    await seedSession(t);
    const state = await t.query(internal.embed.sessionEmbedState, { sessionId: SESSION_ID });
    expect(state).toMatchObject({
      sessionId: SESSION_ID,
      projectKey: PROJECT_KEY,
      sourceFingerprint: '{"size":10,"mtimeMs":20}',
      ingestClaimed: false,
    });
    expect(state?.embeddedFingerprint).toBeUndefined();
    expect(await t.query(internal.embed.sessionEmbedState, { sessionId: "nope" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Pure search shaping
// ---------------------------------------------------------------------------

describe("embedding input + content hash", () => {
  test("embeddingInputFor formats query and document inputs", () => {
    expect(embeddingInputFor({ purpose: "retrieval_query", text: " tailscale setup " })).toBe(
      "task: retrieval_query | query: tailscale setup",
    );
    expect(embeddingInputFor({ purpose: "retrieval_document", text: "row text" })).toBe(
      "task: retrieval_document | text: row text",
    );
    expect(() => embeddingInputFor({ purpose: "retrieval_query", text: "  " })).toThrow(
      /required/,
    );
  });

  test("messageContentHash is stable per text and differs across texts", () => {
    expect(messageContentHash("alpha")).toBe(messageContentHash("alpha"));
    expect(messageContentHash("alpha")).not.toBe(messageContentHash("alphb"));
    expect(messageContentHash("alpha")).toMatch(/^[0-9a-f]{16}:5$/);
  });

  test("messageEntryKey is the row identity", () => {
    expect(messageEntryKey({ sessionId: "s", seq: 3, role: "user" })).toBe("s:3:user");
  });
});

describe("semanticMatchesFromSearch", () => {
  const entries = [
    { entryId: "e1", metadata: { sessionId: "s1", seq: 0, role: "user", projectKey: "p" } },
    { entryId: "e2", metadata: { sessionId: "s1", seq: 1, role: "assistant", projectKey: "p" } },
    { entryId: "alien", metadata: { other: true } },
  ];

  test("joins results to message metadata, dedupes per row, ranks by score", () => {
    const matches = semanticMatchesFromSearch(
      [
        { entryId: "e2", score: 0.8, content: [{ text: "chunk a" }, { text: "chunk b" }] },
        { entryId: "e1", score: 0.9, content: [{ text: "question" }] },
        { entryId: "e2", score: 0.5, content: [{ text: "weaker duplicate" }] },
        { entryId: "alien", score: 0.99, content: [{ text: "no metadata" }] },
      ],
      entries,
      10,
    );
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ sessionId: "s1", seq: 0, score: 0.9, vectorRank: 1 });
    expect(matches[1]).toMatchObject({ seq: 1, score: 0.8, vectorRank: 2, text: "chunk a\nchunk b" });
  });

  test("respects the limit after deduplication", () => {
    const matches = semanticMatchesFromSearch(
      [
        { entryId: "e1", score: 0.9, content: [{ text: "a" }] },
        { entryId: "e2", score: 0.8, content: [{ text: "b" }] },
      ],
      entries,
      1,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.vectorRank).toBe(1);
  });
});

describe("fuseMatches (standard RRF, k = 60)", () => {
  const row = (seq: number, role: string, text: string) => ({
    sessionId: "s1",
    seq,
    role,
    projectKey: "p",
    text,
  });

  test("sums 1/(k+rank) across lists for shared rows", () => {
    expect(RRF_K).toBe(60);
    const fused = fuseMatches({
      lexical: [row(0, "user", "lexical text"), row(1, "assistant", "only lexical")],
      semantic: [row(2, "assistant", "only semantic"), row(0, "user", "semantic excerpt")],
      limit: 10,
    });
    const shared = fused.find((match) => match.seq === 0);
    expect(shared?.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(shared).toMatchObject({ textRank: 1, vectorRank: 2, text: "lexical text" });
    // Shared row outranks both single-list rows.
    expect(fused[0]?.seq).toBe(0);
    const onlyLexical = fused.find((match) => match.seq === 1);
    expect(onlyLexical?.score).toBeCloseTo(1 / 62, 12);
    expect(onlyLexical?.vectorRank).toBeUndefined();
    const onlySemantic = fused.find((match) => match.seq === 2);
    expect(onlySemantic?.score).toBeCloseTo(1 / 61, 12);
    expect(onlySemantic?.textRank).toBeUndefined();
  });

  test("a lexical row outside the conversation surface still fuses (lexical leg spans all roles)", () => {
    const fused = fuseMatches({
      lexical: [row(5, "reasoning", "thought text")],
      semantic: [],
      limit: 10,
    });
    expect(fused).toHaveLength(1);
    expect(fused[0]).toMatchObject({ role: "reasoning", textRank: 1 });
  });

  test("applies the limit and breaks ties deterministically", () => {
    const fused = fuseMatches({
      lexical: [row(0, "user", "a"), row(1, "user", "b"), row(2, "user", "c")],
      semantic: [],
      limit: 2,
    });
    expect(fused.map((match) => match.seq)).toEqual([0, 1]);
  });
});
