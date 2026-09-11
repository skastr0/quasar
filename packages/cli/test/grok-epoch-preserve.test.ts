import { describe, expect, test } from "bun:test";

import { NORMALIZATION_VERSION } from "../src/normalization-version";
import { mapSession } from "../src/map";
import type { NormalizedSession } from "../src/core/schemas";
import type { MappedSession } from "../src/model";
import {
  GrokPreserveError,
  preserveStoredPrefixWithLiveSuffix,
} from "../src/adapters/grok-epoch-merge";

type Turn = readonly [role: "user" | "assistant" | "thinking", text: string];

const build = (
  turns: readonly Turn[],
  options?: { readonly machineId?: string; readonly projectKey?: string },
): MappedSession => {
  const id = "session-preserve";
  const machineId = options?.machineId ?? "machine-a";
  const projectIdentityKey = options?.projectKey ?? "project-a";
  const session: NormalizedSession = {
    id,
    nativeSessionId: id,
    provider: "grok",
    agentName: "grok-build",
    machineId,
    host: "host-a",
    identitySchemeVersion: 1,
    normalizationVersion: NORMALIZATION_VERSION,
    projectIdentity: {
      projectIdentityKey,
      displayName: "Project A",
      confidence: "explicit",
      signals: [],
    },
    sourceRoot: "/grok",
    sourcePath: "/grok/project/session/chat_history.jsonl",
    events: turns.map(([role, text], index) => ({
      id: `${id}:event-${index}`,
      sessionId: id,
      sequence: index,
      machineId,
      provider: "grok" as const,
      agentName: "grok-build",
      projectIdentityKey,
      role,
      kind: role === "thinking" ? ("reasoning" as const) : ("message" as const),
      contentText: text,
      contentBlocks: [],
      rawReference: { sourcePath: "/grok/project/session/chat_history.jsonl", line: index + 1 },
    })),
    toolCalls: [],
    sessionEdges: [],
    executionContexts: [],
    usageRecords: [],
    artifacts: [],
    eventCount: turns.length,
    toolCallCount: 0,
    contentBlockCount: 0,
    sessionEdgeCount: 0,
    usageRecordCount: 0,
    artifactCount: 0,
  };
  return mapSession(session, "fingerprint-a");
};

const preserve = (
  current: MappedSession,
  stored: MappedSession | undefined | (() => Promise<MappedSession | undefined>),
) =>
  preserveStoredPrefixWithLiveSuffix({
    serverUrl: "http://stub.invalid",
    mapped: current,
    fetchStored: typeof stored === "function" ? stored : async () => stored,
  });

describe("preserveStoredPrefixWithLiveSuffix", () => {
  test("keeps every stored row verbatim and appends the live suffix above it", async () => {
    const stored = build([
      ["user", "old one"],
      ["assistant", "old answer"],
      ["user", "shared"],
    ]);
    const current = build([
      ["user", "shared"],
      ["assistant", "new answer"],
    ]);
    const union = await preserve(current, stored);

    expect(union.messages.map((message) => message.text)).toEqual([
      "old one",
      "old answer",
      "shared",
      "new answer",
    ]);
    expect(
      union.messages.slice(0, stored.messages.length).map((message) => `${message.eventId}:${message.seq}`),
    ).toEqual(stored.messages.map((message) => `${message.eventId}:${message.seq}`));
    const storedMaxSeq = Math.max(...stored.messages.map((message) => message.seq));
    expect(union.messages.at(-1)!.seq).toBeGreaterThan(storedMaxSeq);
    expect(union.session.sourceFingerprint).toBe(current.session.sourceFingerprint);
  });

  test("a second run over the union is idempotent", async () => {
    const stored = build([
      ["user", "old one"],
      ["assistant", "old answer"],
      ["user", "shared"],
    ]);
    const current = build([
      ["user", "shared"],
      ["assistant", "new answer"],
    ]);
    const first = await preserve(current, stored);
    const second = await preserve(current, first);
    expect(second.messages.map((message) => `${message.eventId}:${message.seq}:${message.contentHash}`)).toEqual(
      first.messages.map((message) => `${message.eventId}:${message.seq}:${message.contentHash}`),
    );
    expect(second.toolCalls).toEqual(first.toolCalls);
  });

  test("a store that already holds a previous union is not re-appended", async () => {
    // Canonical prefix, then a previously appended suffix, with current live
    // rows in a different relative order (a recap sits after the new turn).
    const stored = build([
      ["user", "old"],
      ["user", "shared"],
      ["assistant", "recap"],
      ["assistant", "previous new"],
    ]);
    const current = build([
      ["user", "shared"],
      ["assistant", "previous new"],
      ["assistant", "recap"],
      ["assistant", "fresh"],
    ]);
    const union = await preserve(current, stored);
    expect(union.messages.map((message) => message.text)).toEqual([
      "old",
      "shared",
      "recap",
      "previous new",
      "fresh",
    ]);
    // Re-running against the produced union appends nothing further.
    const again = await preserve(current, union);
    expect(again.messages.map((message) => `${message.eventId}:${message.seq}`)).toEqual(
      union.messages.map((message) => `${message.eventId}:${message.seq}`),
    );
  });

  test("identical turns at different positions are preserved, not deduplicated", async () => {
    const stored = build([["user", "same text"]]);
    const current = build([
      ["user", "same text"],
      ["assistant", "answer"],
      ["user", "same text"],
    ]);
    const union = await preserve(current, stored);
    expect(union.messages.map((message) => message.text)).toEqual(["same text", "answer", "same text"]);
  });

  test("no stored session yet returns the live projection unchanged", async () => {
    const current = build([
      ["user", "hello"],
      ["assistant", "hi"],
    ]);
    const result = await preserve(current, undefined);
    expect(result).toBe(current);
  });

  test("a machine mismatch fails closed before any write", async () => {
    const stored = build([["user", "old"]], { machineId: "machine-b" });
    const current = build([["user", "old"], ["assistant", "new"]]);
    await expect(preserve(current, stored)).rejects.toMatchObject({
      name: "GrokPreserveError",
      diagnostic: "grok.preserve.machine_mismatch",
    });
  });

  test("a same-id tool with a different payload fails closed", async () => {
    const stored = build([
      ["user", "a"],
      ["assistant", "b"],
    ]);
    const current = build([
      ["user", "a"],
      ["assistant", "c"],
    ]);
    const base = {
      id: "tool-x",
      sessionId: stored.session.sessionId,
      eventId: stored.messages[0]!.eventId,
      seq: 1,
      toolName: "read_file",
      status: "completed",
      projectKey: stored.session.projectKey,
      provider: "grok" as const,
    };
    (stored.toolCalls as MappedSession["toolCalls"][number][]).push({
      ...base,
      inputText: "old input",
      outputText: "old output",
    });
    (current.toolCalls as MappedSession["toolCalls"][number][]).push({
      ...base,
      inputText: "changed input",
      outputText: "old output",
    });
    await expect(preserve(current, stored)).rejects.toMatchObject({
      diagnostic: "grok.preserve.unsafe_union",
    });
  });

  test("a fetch failure surfaces as a named preservation error", async () => {
    const current = build([["user", "hello"]]);
    await expect(
      preserve(current, async () => {
        throw new GrokPreserveError("grok.preserve.fetch_failed", "read failed");
      }),
    ).rejects.toMatchObject({ diagnostic: "grok.preserve.fetch_failed" });
  });
});
