import { describe, expect, test } from "bun:test";
import {
  decodeMappedSessionSync,
  decodeNormalizedSessionSync,
} from "@skastr0/quasar-protocol";
import { Schema } from "effect";

import {
  AMP_LIST_PAGE_SIZE,
  AMP_LIST_PAGE_STRIDE,
  ampAdapter,
  type AmpRunner,
  type AmpStreamOptions,
} from "../src/adapters/amp";
import { stableJsonHash } from "../src/core/hash";
import { AmpExportSchema, AmpThreadListEntrySchema } from "../src/adapters/amp-schema";
import { sessionIdFor } from "../src/adapters/common";
import { adaptersByProvider, stableAdapters } from "../src/adapters/registry";
import { AmpSessionId } from "../src/core/identity";
import { mapSession } from "../src/map";

// ---------------------------------------------------------------------------
// Fixtures — hand-authored from measured amp list/export shapes (2026-07-24)
// ---------------------------------------------------------------------------

const MACHINE_A = {
  machineId: "machine:aaaaaaaa",
  hostname: "host-a",
  platform: "darwin",
};
const MACHINE_B = {
  machineId: "machine:bbbbbbbb",
  hostname: "host-b",
  platform: "linux",
};
const NOW = "2026-07-24T12:00:00.000Z";

const readAmp = (options: AmpStreamOptions) => ampAdapter.read(options);

const THREAD_A = "T-recent-0001";
const THREAD_B = "T-recent-0002";
const THREAD_OLD = "T-old-0003";

const listPage = [
  {
    id: THREAD_A,
    title: "Recent thread",
    updated: "2026-07-20T12:00:00.000Z",
    tree: "file:///Users/dev/projects/widget",
    messageCount: 4,
  },
  {
    id: THREAD_B,
    title: "Second thread",
    updated: "2026-07-19T12:00:00.000Z",
    tree: "file:///Users/dev/projects/other",
    messageCount: 2,
  },
  {
    id: THREAD_OLD,
    title: "Old thread",
    updated: "2026-01-01T00:00:00.000Z",
    tree: "file:///Users/dev/projects/old",
    messageCount: 1,
  },
];

/** Captured-shape export with text, thinking, tool_use + tool_result. */
const recentExport = {
  v: 24,
  id: THREAD_A,
  title: "Recent thread",
  created: 1_746_100_000_000,
  updatedAt: "2026-07-20T12:00:00.000Z",
  env: {
    initial: {
      trees: [
        {
          uri: "file:///Users/dev/projects/widget",
          repository: {
            url: "https://github.com/example/widget",
            type: "git",
          },
          displayName: "widget",
        },
      ],
    },
  },
  meta: {
    customAgentDisplay: { model: "xai/grok-4.5", label: "Grok 4.5" },
  },
  messages: [
    {
      role: "user",
      meta: { sentAt: 1_746_100_000_000 },
      content: [{ type: "text", text: "Please refactor the widget module." }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "The user wants a refactor; I should inspect the file first.",
          signature: "",
          openAIReasoning: {
            encryptedContent: "ENCRYPTED-OPAQUE-BLOB-SHOULD-NEVER-SURFACE",
          },
        },
        {
          type: "text",
          text: "Let me read the widget file.",
        },
        {
          type: "tool_use",
          id: "TU-aaa",
          name: "read_file",
          input: { path: "src/widget.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseID: "TU-aaa",
          run: {
            result: {
              content: [{ type: "text", text: "export const widget = () => 42;" }],
            },
            status: "done",
          },
        },
      ],
    },
  ],
};

const emptyExport = {
  v: 24,
  id: THREAD_B,
  messages: [],
  created: 1_746_000_000_000,
};

const noSleep = async () => {};

const fixtureRunner = (exportsById: Record<string, unknown> = {}): AmpRunner => {
  const exports: Record<string, unknown> = {
    [THREAD_A]: recentExport,
    [THREAD_B]: emptyExport,
    [THREAD_OLD]: { v: 24, messages: [] },
    ...exportsById,
  };
  return (args) => {
    if (args[0] === "--version") return { ok: true, stdout: "0.0.1\n" };
    if (args[0] === "threads" && args[1] === "list") {
      const offsetIndex = args.indexOf("--offset");
      const offset = offsetIndex >= 0 ? Number(args[offsetIndex + 1]) : 0;
      return { ok: true, stdout: JSON.stringify(offset === 0 ? listPage : []) };
    }
    if (args[0] === "threads" && args[1] === "export") {
      const id = args[2];
      if (id !== undefined && exports[id] !== undefined) {
        return { ok: true, stdout: JSON.stringify(exports[id]) };
      }
      return { ok: false, reason: "command_failed", detail: `unknown thread ${id}` };
    }
    return { ok: false, reason: "command_failed" };
  };
};

const read = (machine: typeof MACHINE_A, options: Partial<AmpStreamOptions> = {}) =>
  readAmp({
    machine,
    now: NOW,
    ampRunner: fixtureRunner(),
    ampSleep: noSleep,
    exportSpacingMs: 0,
    ...options,
  });

// ---------------------------------------------------------------------------
// Registry gating
// ---------------------------------------------------------------------------

describe("amp registry", () => {
  test("amp is stable and included in the all-provider set", () => {
    expect(adaptersByProvider.get("amp")).toBe(ampAdapter);
    expect(stableAdapters.map((adapter) => adapter.provider)).toContain("amp");
    expect(ampAdapter.stable).toBe(true);
    expect(ampAdapter.provider).toBe("amp");
    expect(ampAdapter.id).toBe("amp-threads-cli");
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("amp machine-independent identity", () => {
  test("session id is byte-identical across machines and omits machineId", async () => {
    const a = await read(MACHINE_A, { limit: 1 });
    const b = await read(MACHINE_B, { limit: 1 });
    expect(a.sessions.length).toBeGreaterThanOrEqual(1);
    expect(a.sessions[0]!.id).toBe(b.sessions[0]!.id);
    expect(a.sessions[0]!.id).toBe(sessionIdFor("amp", AmpSessionId(THREAD_A)));
    expect(a.sessions[0]!.id).not.toContain(MACHINE_A.machineId);
    expect(b.sessions[0]!.id).not.toContain(MACHINE_B.machineId);
  });
});

// ---------------------------------------------------------------------------
// Fingerprint round-trip
// ---------------------------------------------------------------------------

describe("amp fingerprint round-trip", () => {
  test("shouldParseSession sourceFingerprint is byte-identical to item.fingerprint", async () => {
    const probeFingerprints: string[] = [];
    const itemFingerprints: string[] = [];
    const exportCalls: string[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "threads" && args[1] === "export") {
        exportCalls.push(args[2] ?? "");
      }
      return fixtureRunner()(args);
    };

    for await (const item of ampAdapter.stream!({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      limit: 1,
      shouldParseSession: (probe) => {
        probeFingerprints.push(probe.sourceFingerprint);
        return true;
      },
    } as AmpStreamOptions)) {
      if (item.type === "session") {
        itemFingerprints.push(JSON.stringify(item.fingerprint));
      }
    }

    expect(probeFingerprints).toHaveLength(1);
    expect(itemFingerprints).toHaveLength(1);
    expect(itemFingerprints[0]).toBe(probeFingerprints[0]);
    expect(exportCalls).toEqual([THREAD_A]);
  });

  test("unchanged fingerprint skips export entirely", async () => {
    const exportCalls: string[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "threads" && args[1] === "export") {
        exportCalls.push(args[2] ?? "");
      }
      return fixtureRunner()(args);
    };
    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      shouldParseSession: () => false,
    });
    expect(result.sessions).toHaveLength(0);
    expect(exportCalls).toHaveLength(0);
  });

  test("messageCount participates in fingerprint tag (content growth without updated bump)", async () => {
    // Same updated/title/tree; only messageCount differs → tag must change so the
    // fingerprint gate re-exports when content grows without an updated bump.
    const base = {
      id: "T-fp-base",
      title: "Same title",
      updated: "2026-07-20T12:00:00.000Z",
      tree: "file:///Users/dev/projects/widget",
      messageCount: 4,
    };
    const grown = { ...base, id: "T-fp-grown", messageCount: 5 };
    const probes: string[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offsetIndex = args.indexOf("--offset");
        const offset = offsetIndex >= 0 ? Number(args[offsetIndex + 1]) : 0;
        return { ok: true, stdout: JSON.stringify(offset === 0 ? [base, grown] : []) };
      }
      return { ok: false, reason: "command_failed" };
    };
    await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      shouldParseSession: (probe) => {
        probes.push(probe.sourceFingerprint);
        return false;
      },
    });
    expect(probes).toHaveLength(2);
    expect(probes[0]).not.toBe(probes[1]);
    // Also prove the production hash formula includes messageCount explicitly.
    const tagWithCount = stableJsonHash({
      updated: base.updated,
      title: base.title,
      tree: base.tree,
      messageCount: base.messageCount,
    });
    const tagWithoutCount = stableJsonHash({
      updated: base.updated,
      title: base.title,
      tree: base.tree,
    });
    expect(tagWithCount).not.toBe(tagWithoutCount);
    expect(probes[0]).toBe(JSON.stringify({ tag: tagWithCount }));
  });

  test("absent shouldParseSession (force) still exports", async () => {
    const exportCalls: string[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "threads" && args[1] === "export") {
        exportCalls.push(args[2] ?? "");
      }
      return fixtureRunner()(args);
    };
    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      limit: 2,
    });
    expect(result.sessions.length).toBe(2);
    expect(exportCalls).toEqual([THREAD_A, THREAD_B]);
  });

  test("uses the archived-inclusive list contract on every page", async () => {
    const listCalls: readonly string[][] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        (listCalls as string[][]).push([...args]);
        return { ok: true, stdout: JSON.stringify([]) };
      }
      return { ok: false, reason: "command_failed" };
    };
    await readAmp({ machine: MACHINE_A, now: NOW, ampRunner: runner, ampSleep: noSleep });
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toContain("--include-archived");
  });

  test("never reuses one export for a different thread with identical fingerprint metadata", async () => {
    const first = { ...listPage[0], id: "T-identical-a", title: "same", messageCount: 1 };
    const second = { ...listPage[0], id: "T-identical-b", title: "same", messageCount: 1 };
    const calls: string[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") return { ok: true, stdout: JSON.stringify([first, second]) };
      if (args[0] === "threads" && args[1] === "export") {
        const id = args[2]!;
        calls.push(id);
        return {
          ok: true,
          stdout: JSON.stringify({
            id,
            messages: [{ role: "user", content: [{ type: "text", text: `payload:${id}` }] }],
          }),
        };
      }
      return { ok: false, reason: "command_failed" };
    };
    const result = await readAmp({ machine: MACHINE_A, now: NOW, ampRunner: runner, ampSleep: noSleep, exportSpacingMs: 0 });
    expect(calls).toEqual([first.id, second.id]);
    expect(result.sessions.map((session) => session.events[0]?.contentText)).toEqual([
      `payload:${first.id}`,
      `payload:${second.id}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe("amp content mapping", () => {
  test("text/thinking/tool_use/tool_result map correctly and merge by toolUseID", async () => {
    const result = await read(MACHINE_A, { limit: 1 });
    const session = result.sessions[0]!;
    expect(session.provider).toBe("amp");
    expect(session.sourceRoot).toBe("https://ampcode.com/threads");
    expect(session.sourcePath).toBe(`https://ampcode.com/threads/${THREAD_A}`);
    expect(session.nativeSessionId).toBe(THREAD_A);

    expect(() => decodeNormalizedSessionSync(session)).not.toThrow();

    const reasoning = session.events.filter((event) => event.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.role).toBe("thinking");
    expect(reasoning[0]!.contentText).toContain("inspect the file first");

    expect(session.toolCalls).toHaveLength(1);
    const toolCall = session.toolCalls[0]!;
    expect(toolCall.toolName).toBe("read_file");
    expect(toolCall.status).toBe("done");
    expect(JSON.stringify(toolCall.input)).toContain("src/widget.ts");
    expect(JSON.stringify(toolCall.output)).toContain("export const widget");
    expect(toolCall.eventId.length).toBeGreaterThan(0);

    const linked = session.events.filter((event) => event.toolCallId === toolCall.id);
    expect(linked.length).toBeGreaterThanOrEqual(2);
    expect(linked.some((event) => event.kind === "tool_call")).toBe(true);
    expect(linked.some((event) => event.kind === "tool_result")).toBe(true);

    for (const event of session.events) {
      expect(event.rawReference.sourcePath).toBe(session.sourcePath);
    }

    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("ENCRYPTED-OPAQUE-BLOB-SHOULD-NEVER-SURFACE");
  });

  test("project path and git remote come from tree / repository.url", async () => {
    const result = await read(MACHINE_A, { limit: 1 });
    const session = result.sessions[0]!;
    expect(session.projectIdentity.rawPath ?? session.projectIdentity.normalizedPath ?? "").toContain(
      "widget",
    );
    expect(session.projectIdentity.gitRemote ?? "").toContain("example/widget");
  });

  test("mapSession succeeds end-to-end", async () => {
    const streamItems = [];
    for await (const item of ampAdapter.stream!({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: fixtureRunner(),
      ampSleep: noSleep,
      exportSpacingMs: 0,
      limit: 1,
    } as AmpStreamOptions)) {
      streamItems.push(item);
    }
    const sessionItem = streamItems.find((item) => item.type === "session");
    expect(sessionItem?.type).toBe("session");
    if (sessionItem?.type !== "session") return;
    const fingerprint = JSON.stringify(sessionItem.fingerprint);
    const mapped = mapSession(sessionItem.session, fingerprint);
    expect(() => decodeMappedSessionSync(mapped)).not.toThrow();
    expect(mapped.session.sessionId).toBe(sessionItem.session.id);
    expect(mapped.session.sourceFingerprint).toBe(fingerprint);
    expect(mapped.messages.length).toBeGreaterThan(0);
  });

  test("preserves protocol message identity for every block event through mapSession", async () => {
    const exported = {
      ...recentExport,
      messages: [{
        role: "assistant",
        protocolMessageID: "protocol-unique",
        messageId: 42,
        content: [
          { type: "text", text: "one" },
          { type: "thinking", thinking: "two" },
          { type: "summary", summary: { type: "summary", summary: "three" } },
          { type: "image", sourcePath: "four.png" },
        ],
      }],
    };
    const items = [];
    for await (const item of ampAdapter.stream!({ machine: MACHINE_A, now: NOW, ampRunner: fixtureRunner({ [THREAD_A]: exported }), ampSleep: noSleep, exportSpacingMs: 0, limit: 1 } as AmpStreamOptions)) items.push(item);
    const sessionItem = items.find((item) => item.type === "session");
    if (sessionItem?.type !== "session") throw new Error("expected session");
    expect(sessionItem.session.events.map((event) => event.nativeEventId)).toEqual([
      "protocol-unique:0", "protocol-unique:1", "protocol-unique:2", "protocol-unique:3",
    ]);
    const mapped = mapSession(sessionItem.session, JSON.stringify(sessionItem.fingerprint));
    expect(mapped.messages).toHaveLength(3);
  });

  test("maps measured usage, nested summary, and image attachment metadata", async () => {
    const exportWithNonText = {
      ...recentExport,
      messages: [
        {
          role: "assistant",
          usage: {
            model: "openai/gpt-5",
            timestamp: "2026-07-20T12:01:00.000Z",
            inputTokens: 12,
            outputTokens: 34,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 6,
            totalInputTokens: 23,
            maxInputTokens: 100,
          },
          content: [
            { type: "summary", summary: { type: "summary", summary: "Nested context summary." } },
            { type: "image", source: { type: "url", url: "https://images.example.test/image.png" }, sourcePath: "image.png" },
          ],
        },
      ],
    };
    const result = await read(MACHINE_A, {
      ampRunner: fixtureRunner({ [THREAD_A]: exportWithNonText }),
      limit: 1,
    });
    const session = result.sessions[0]!;
    const summary = session.events.find((event) => event.kind === "summary");
    expect(summary?.contentText).toBe("Nested context summary.");
    expect(session.usageRecords).toHaveLength(1);
    expect(session.usageRecords[0]).toMatchObject({
      model: "openai/gpt-5",
      inputTokens: 12,
      outputTokens: 34,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 6,
    });
    expect(session.artifacts).toHaveLength(2);
    const imageEvent = session.events.find((event) => event.contentBlocks.some((block) => block.kind === "image"));
    expect(imageEvent?.contentBlocks[0]).toMatchObject({ kind: "image", path: "image.png", uri: "https://images.example.test/image.png" });
    expect(session.artifacts[0]).toMatchObject({ kind: "image", eventId: imageEvent?.id, sourceRef: { sourcePath: "image.png" } });
    expect(session.artifacts[1]).toMatchObject({ kind: "usage_metadata", sourceRef: { maxInputTokens: 100, totalInputTokens: 23 } });
  });

  test("preserves exact multiline text, thinking, and summary blocks through mapSession", async () => {
    const text = "Answer line one\n\n```ts\nconst value = 1;\n```\n";
    const thinking = "Reason line one\n  indented reason\n\nReason line three";
    const summary = "Summary line one\n\n- first\n- second\n";
    const exported = {
      ...recentExport,
      messages: [{
        role: "assistant",
        protocolMessageID: "protocol-formatting",
        content: [
          { type: "text", text },
          { type: "thinking", thinking },
          { type: "summary", summary: { type: "summary", summary } },
        ],
      }],
    };
    const result = await read(MACHINE_A, {
      ampRunner: fixtureRunner({ [THREAD_A]: exported }),
      limit: 1,
    });
    const session = result.sessions[0]!;
    const [textEvent, thinkingEvent, summaryEvent] = session.events;
    expect(textEvent?.contentText).toBe("Answer line one ```ts const value = 1; ```");
    expect(textEvent?.contentBlocks).toEqual([
      expect.objectContaining({ kind: "text", text }),
    ]);
    expect(thinkingEvent?.contentText).toBe("Reason line one indented reason Reason line three");
    expect(thinkingEvent?.contentBlocks).toEqual([
      expect.objectContaining({ kind: "thinking", thinking }),
    ]);
    expect(summaryEvent?.contentText).toBe("Summary line one - first - second");
    expect(summaryEvent?.contentBlocks).toEqual([
      expect.objectContaining({ kind: "text", text: summary }),
    ]);

    const mapped = mapSession(session, "formatting-fingerprint");
    expect(mapped.events.map((event) => event.contentBlocks[0])).toEqual([
      expect.objectContaining({ kind: "text", text }),
      expect.objectContaining({ kind: "thinking", thinking }),
      expect.objectContaining({ kind: "text", text: summary }),
    ]);
  });

  test("preserves observed session configuration, response phase, block facts, and image time", async () => {
    const toolStart = "2026-07-20T12:01:00.000Z";
    const toolFinal = "2026-07-20T12:01:02.000Z";
    const resultFinal = "2026-07-20T12:01:05.000Z";
    const imageSentAt = 1_753_012_900_000;
    const exported = {
      ...recentExport,
      reasoningEffort: "high",
      agentMode: "deep",
      activatedSkills: [{ name: "review" }],
      archived: true,
      meta: { ...recentExport.meta, agentMode: "deep" },
      messages: [
        {
          role: "assistant",
          protocolMessageID: "protocol-source-facts",
          meta: { openAIResponsePhase: "final_answer" },
          state: { type: "cancelled", stopReason: "end_turn" },
          content: [
            {
              type: "thinking",
              thinking: "Observed reasoning.",
              startTime: "2026-07-20T12:00:58.000Z",
              finalTime: "2026-07-20T12:00:59.000Z",
              provider: "openai",
              blockState: "streaming",
            },
            {
              type: "tool_use",
              id: "TU-source-facts",
              name: "shell",
              input: { command: "pwd" },
              startTime: toolStart,
              finalTime: toolFinal,
              complete: true,
              blockState: "complete",
              providerToolUseId: "provider-tool-source-facts",
            },
          ],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            toolUseID: "TU-source-facts",
            run: { status: "cancelled", result: { output: "cancelled" } },
            startTime: "2026-07-20T12:01:03.000Z",
            finalTime: resultFinal,
            blockState: "complete",
          }],
        },
        {
          role: "user",
          meta: { sentAt: imageSentAt },
          content: [{ type: "image", sourcePath: "observed.png" }],
        },
      ],
    };

    const result = await read(MACHINE_A, {
      ampRunner: fixtureRunner({ [THREAD_A]: exported }),
      limit: 1,
    });
    const session = result.sessions[0]!;
    expect(session.executionContexts).toEqual([
      expect.objectContaining({ scope: "session", reasoningEffort: "high" }),
    ]);
    expect(session.artifacts.find((artifact) => artifact.kind === "amp_session_configuration")?.sourceRef).toEqual({
      agentMode: "deep",
      metaAgentMode: "deep",
      activatedSkills: [{ name: "review" }],
      archived: true,
    });
    const thinking = session.events.find((event) => event.kind === "reasoning");
    expect(thinking?.contentBlocks[0]?.metadata).toEqual({
      startTime: "2026-07-20T12:00:58.000Z",
      finalTime: "2026-07-20T12:00:59.000Z",
      provider: "openai",
      blockState: "streaming",
      openAIResponsePhase: "final_answer",
      state: { type: "cancelled", stopReason: "end_turn" },
    });
    const toolCallEvent = session.events.find((event) => event.kind === "tool_call");
    expect(toolCallEvent?.contentBlocks[0]?.metadata).toMatchObject({
      startTime: toolStart,
      finalTime: toolFinal,
      complete: true,
      blockState: "complete",
      providerToolUseId: "provider-tool-source-facts",
      openAIResponsePhase: "final_answer",
    });
    expect(session.toolCalls[0]).toMatchObject({
      status: "cancelled",
      startedAt: toolStart,
      completedAt: resultFinal,
    });
    const image = session.events.find((event) =>
      event.contentBlocks.some((block) => block.kind === "image"));
    expect(image?.timestamp).toBe(new Date(imageSentAt).toISOString());

    const mapped = mapSession(session, "source-facts-fingerprint");
    expect(mapped.events.find((event) => event.id === thinking?.id)?.contentBlocks[0]?.metadata).toEqual(
      thinking?.contentBlocks[0]?.metadata,
    );
    expect(mapped.executionContexts[0]?.reasoningEffort).toBe("high");
  });

  test("maps observed server-tool search and manual bash blocks", async () => {
    const exported = {
      ...recentExport,
      messages: [
        {
          role: "assistant",
          protocolMessageID: "protocol-server-tool",
          state: { type: "complete", stopReason: "tool_use" },
          content: [
            {
              type: "server_tool_use",
              id: "server-tool-1",
              name: "tool_search_tool_regex",
              input: { limit: 5, pattern: "shell" },
            },
            {
              type: "tool_search_tool_result",
              toolUseID: "server-tool-1",
              content: {
                type: "tool_search_tool_search_result",
                toolReferences: [{ name: "shell" }, { name: "read_file" }],
              },
            },
          ],
        },
        {
          role: "info",
          protocolMessageID: "protocol-manual-bash",
          content: [{
            type: "manual_bash_invocation",
            args: { cmd: "printf hello" },
            hidden: false,
            toolRun: {
              status: "done",
              result: { output: "hello", exitCode: 0 },
            },
          }],
        },
      ],
    };

    const result = await read(MACHINE_A, {
      ampRunner: fixtureRunner({ [THREAD_A]: exported }),
      limit: 1,
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.status === "error")).toHaveLength(0);
    const session = result.sessions[0]!;
    expect(session.toolCalls).toHaveLength(2);

    const serverTool = session.toolCalls.find((toolCall) => toolCall.toolName === "tool_search_tool_regex");
    expect(serverTool).toMatchObject({
      status: "completed",
      input: { limit: 5, pattern: "shell" },
      output: {
        type: "tool_search_tool_search_result",
        toolReferences: [{ name: "shell" }, { name: "read_file" }],
      },
    });
    expect(
      session.events.find((event) =>
        event.rawReference.nativeType === "tool_search_tool_result")?.toolCallId,
    ).toBe(serverTool?.id);

    const manualBash = session.toolCalls.find((toolCall) => toolCall.toolName === "manual_bash_invocation");
    expect(manualBash).toMatchObject({
      status: "done",
      input: { cmd: "printf hello" },
      output: {
        status: "done",
        result: { output: "hello", exitCode: 0 },
      },
    });
    const manualEvent = session.events.find((event) =>
      event.rawReference.nativeType === "manual_bash_invocation");
    expect(manualEvent).toMatchObject({
      kind: "tool_call",
      role: "assistant",
      toolCallId: manualBash?.id,
    });
    expect(manualEvent?.contentBlocks[0]?.metadata).toEqual({ hidden: false });

    const mapped = mapSession(session, "observed-amp-tool-blocks");
    expect(mapped.messages).toHaveLength(0);
    expect(mapped.toolCalls).toHaveLength(2);
  });

  test("unknown content blocks fail closed for the affected session", async () => {
    const result = await read(MACHINE_A, {
      ampRunner: fixtureRunner({
        [THREAD_A]: { ...recentExport, messages: [{ role: "assistant", content: [{ type: "future_block" }] }] },
      }),
      limit: 1,
      shouldParseSession: (probe) => probe.sessionId === sessionIdFor("amp", AmpSessionId(THREAD_A)),
    });
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.find((d) => diagnosticName(d) === "amp.block.unknown")?.status).toBe("error");
  });

  test("image without a stable source fails closed", async () => {
    const result = await read(MACHINE_A, {
      ampRunner: fixtureRunner({ [THREAD_A]: { ...recentExport, messages: [{ role: "assistant", content: [{ type: "image" }] }] } }),
      limit: 1,
      shouldParseSession: (probe) => probe.sessionId === sessionIdFor("amp", AmpSessionId(THREAD_A)),
    });
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.find((d) => diagnosticName(d) === "amp.block.image.decode_failed")?.status).toBe("error");
  });

  test("tool results retain full run payload and native status while event text stays projected", async () => {
    const run = { status: "failed", result: { exitCode: 17, output: "stderr text", content: [{ type: "json", value: { retained: true } }] } };
    const result = await read(MACHINE_A, {
      ampRunner: fixtureRunner({ [THREAD_A]: { ...recentExport, messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "TU-full", name: "shell", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseID: "TU-full", run }] },
      ] } }),
      limit: 1,
    });
    const tool = result.sessions[0]!.toolCalls[0]!;
    expect(tool.output).toMatchObject({ status: "failed", result: { exitCode: 17, output: "stderr text", content: [{ type: "json", value: { retained: true } }] } });
    expect(tool.status).toBe("failed");
    expect(result.sessions[0]!.events.find((event) => event.kind === "tool_result")?.contentText).toBe("stderr text");
  });

  test("selected block-schema failures and invalid messages fail closed", async () => {
    for (const messages of [
      [{ role: "assistant", content: [{ type: "text" }] }],
      [{ content: [] }],
      [{ role: "future_role", content: [] }],
    ]) {
      const result = await read(MACHINE_A, {
        ampRunner: fixtureRunner({ [THREAD_A]: { ...recentExport, messages } }),
        limit: 1,
        shouldParseSession: (probe) => probe.sessionId === sessionIdFor("amp", AmpSessionId(THREAD_A)),
      });
      expect(result.sessions).toHaveLength(0);
      expect(result.diagnostics.some((d) => d.status === "error")).toBe(true);
    }
  });

  test("zero list messageCount does not discard a nonempty export", async () => {
    const exportWithMessage = {
      ...recentExport,
      messages: [{ role: "user", content: [{ type: "text", text: "Export is authoritative." }] }],
    };
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        return { ok: true, stdout: JSON.stringify([{ ...listPage[0], messageCount: 0 }]) };
      }
      if (args[0] === "threads" && args[1] === "export") {
        return { ok: true, stdout: JSON.stringify(exportWithMessage) };
      }
      return { ok: false, reason: "command_failed" };
    };
    const result = await read(MACHINE_A, { ampRunner: runner, limit: 1 });
    expect(result.sessions[0]?.events.some((event) => event.contentText === "Export is authoritative.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting / sequential export
// ---------------------------------------------------------------------------

describe("amp sequential export + backoff", () => {
  test("exports are sequential with spacing and never concurrent", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sleepCalls: number[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "threads" && args[1] === "export") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        inFlight -= 1;
      }
      return fixtureRunner()(args);
    };
    await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: async (ms) => {
        sleepCalls.push(ms);
      },
      exportSpacingMs: 3_000,
      limit: 2,
    });
    expect(maxInFlight).toBe(1);
    // First export has no spacing; second is spaced.
    expect(sleepCalls.filter((ms) => ms === 3_000).length).toBe(1);
  });

  test("rate-limited export retries with exponential backoff", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "0.0.1\n" };
      if (args[0] === "threads" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify([listPage[0]]),
        };
      }
      if (args[0] === "threads" && args[1] === "export") {
        attempts += 1;
        if (attempts < 3) {
          return { ok: false, reason: "rate_limited", detail: "HTTP 429" };
        }
        return { ok: true, stdout: JSON.stringify(recentExport) };
      }
      return { ok: false, reason: "command_failed" };
    };
    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: async (ms) => {
        sleeps.push(ms);
      },
      exportSpacingMs: 0,
      limit: 1,
    });
    expect(result.sessions).toHaveLength(1);
    expect(attempts).toBe(3);
    expect(sleeps).toContain(1_000);
    expect(sleeps).toContain(2_000);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed diagnostics
// ---------------------------------------------------------------------------

describe("amp fail-closed boundary", () => {
  test("missing CLI yields a single diagnostic and zero sessions", async () => {
    const runner: AmpRunner = () => ({ ok: false, reason: "missing_binary" });
    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
    });
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.details && (d.details as { diagnostic?: string }).diagnostic === "amp.cli.not_found")).toBe(true);
  });

  test("malformed list entry is dropped with a named diagnostic; others continue", async () => {
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "0.0.1\n" };
      if (args[0] === "threads" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify([
            { title: "no id" },
            listPage[0],
          ]),
        };
      }
      return fixtureRunner()(args);
    };
    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      limit: 1,
    });
    expect(result.sessions).toHaveLength(1);
    expect(
      result.diagnostics.some(
        (d) =>
          d.details !== undefined
          && typeof d.details === "object"
          && (d.details as { diagnostic?: string }).diagnostic === "amp.list.entry.decode_failed",
      ),
    ).toBe(true);
    expect(
      result.diagnostics.find((d) => diagnosticName(d) === "amp.list.entry.decode_failed")?.status,
    ).toBe("error");
  });

  test("malformed export yields a named diagnostic and zero rows for that thread", async () => {
    const runner: AmpRunner = (args) => {
      if (args[0] === "threads" && args[1] === "export") {
        return { ok: true, stdout: "not-json{{{" };
      }
      return fixtureRunner()(args);
    };
    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      limit: 1,
    });
    expect(result.sessions).toHaveLength(0);
    expect(
      result.diagnostics.some(
        (d) =>
          d.details !== undefined
          && typeof d.details === "object"
          && (d.details as { diagnostic?: string }).diagnostic === "amp.export.invalid_json",
      ),
    ).toBe(true);
  });

  test.each([
    ["empty object", {}],
    ["error envelope", { error: "upstream failed" }],
    ["missing messages", { id: THREAD_A }],
  ])("rejects %s export payload", async (_label, payload) => {
    const result = await read(MACHINE_A, {
      ampRunner: fixtureRunner({ [THREAD_A]: payload }),
      limit: 1,
      shouldParseSession: (probe) => probe.sessionId === sessionIdFor("amp", AmpSessionId(THREAD_A)),
    });
    expect(result.sessions).toHaveLength(0);
    const diagnostic = result.diagnostics.find((d) => diagnosticName(d) === "amp.export.decode_failed");
    expect(diagnostic?.status).toBe("error");
    expect((diagnostic?.details as { sourcePath?: string } | undefined)?.sourcePath).toBe(
      `https://ampcode.com/threads/${THREAD_A}`,
    );
  });

  test("attributes separate malformed exports to their own thread URLs", async () => {
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "0.0.1\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offset = Number(args[args.indexOf("--offset") + 1]);
        return { ok: true, stdout: JSON.stringify(offset === 0 ? listPage.slice(0, 2) : []) };
      }
      if (args[0] === "threads" && args[1] === "export") {
        return { ok: true, stdout: "{}" };
      }
      return { ok: false, reason: "command_failed" };
    };
    const result = await read(MACHINE_A, {
      ampRunner: runner,
    });
    const sourcePaths = result.diagnostics
      .filter((diagnostic) => diagnosticName(diagnostic) === "amp.export.decode_failed")
      .map((diagnostic) => (diagnostic.details as { sourcePath?: string }).sourcePath);
    expect(sourcePaths).toEqual([
      `https://ampcode.com/threads/${THREAD_A}`,
      `https://ampcode.com/threads/${THREAD_B}`,
    ]);
  });

  test("rejects an export whose native id differs from the requested thread", async () => {
    const result = await read(MACHINE_A, {
      ampRunner: fixtureRunner({ [THREAD_A]: { ...recentExport, id: THREAD_B } }),
      limit: 1,
      shouldParseSession: (probe) => probe.sessionId === sessionIdFor("amp", AmpSessionId(THREAD_A)),
    });
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.some((d) => diagnosticName(d) === "amp.export.id_mismatch")).toBe(true);
  });

  test("retries a failed later list page and aborts before exporting partial enumeration", async () => {
    let laterPageAttempts = 0;
    const exports: string[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offset = Number(args[args.indexOf("--offset") + 1]);
        if (offset === 0) return { ok: true, stdout: JSON.stringify(makeListPage(0, Date.parse("2026-07-20T12:00:00.000Z"), 60_000)) };
        laterPageAttempts += 1;
        return { ok: false, reason: "command_failed" };
      }
      if (args[0] === "threads" && args[1] === "export") {
        exports.push(args[2] ?? "");
        return { ok: true, stdout: JSON.stringify(recentExport) };
      }
      return { ok: false, reason: "command_failed" };
    };
    const result = await readAmp({ machine: MACHINE_A, now: NOW, ampRunner: runner, ampSleep: noSleep, exportSpacingMs: 0 });
    expect(laterPageAttempts).toBe(3);
    expect(exports).toEqual([]);
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.find((d) => diagnosticName(d) === "amp.list.failed")?.status).toBe("error");
  });

  test.each([{}, { error: "upstream failed" }, { threads: {} }])("rejects invalid list envelope %#", async (payload) => {
    let exports = 0;
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") return { ok: true, stdout: JSON.stringify(payload) };
      if (args[0] === "threads" && args[1] === "export") { exports += 1; return { ok: true, stdout: JSON.stringify(recentExport) }; }
      return { ok: false, reason: "command_failed" };
    };
    const result = await readAmp({ machine: MACHINE_A, now: NOW, ampRunner: runner, ampSleep: noSleep });
    expect(exports).toBe(0);
    expect(result.diagnostics.find((d) => diagnosticName(d) === "amp.list.invalid_envelope")?.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Complete remote pagination
// ---------------------------------------------------------------------------

/** Build a full list page of size LIST_PAGE_SIZE, updated-descending from startMs. */
const makeListPage = (
  pageIndex: number,
  startMs: number,
  stepMs: number,
  extra?: ReadonlyArray<{ readonly id: string; readonly updated: string }>,
): unknown[] => {
  const entries: unknown[] = [];
  for (let i = 0; i < AMP_LIST_PAGE_SIZE; i += 1) {
    const ms = startMs - i * stepMs;
    entries.push({
      id: `T-p${pageIndex}-${String(i).padStart(4, "0")}`,
      title: `Thread p${pageIndex}-${i}`,
      updated: new Date(ms).toISOString(),
      tree: "file:///Users/dev/projects/widget",
      messageCount: 1,
    });
  }
  if (extra !== undefined) {
    for (const item of extra) {
      // Replace last slots so page stays full when we need a full page.
      const slot = entries.length - 1 - (extra.indexOf(item) % entries.length);
      entries[slot] = {
        id: item.id,
        title: item.id,
        updated: item.updated,
        tree: "file:///Users/dev/projects/widget",
        messageCount: 1,
      };
    }
  }
  // Keep fixtures representative of Amp's usual newest-first list.
  entries.sort((left, right) => {
    const leftMs = Date.parse((left as { updated: string }).updated);
    const rightMs = Date.parse((right as { updated: string }).updated);
    return rightMs - leftMs;
  });
  return entries;
};

const overlapFullPage = (previous: readonly unknown[], next: readonly unknown[]): unknown[] => [
  previous[previous.length - 1]!,
  ...next.slice(0, AMP_LIST_PAGE_STRIDE),
];

const diagnosticName = (d: { details?: unknown }): string | undefined => {
  if (d.details === undefined || typeof d.details !== "object" || d.details === null) {
    return undefined;
  }
  const name = (d.details as { diagnostic?: unknown }).diagnostic;
  return typeof name === "string" ? name : undefined;
};

describe("amp complete pagination", () => {
  test("overlapping pages preserve every boundary row", async () => {
    const page0 = makeListPage(0, Date.parse("2026-07-20T12:00:00.000Z"), 60_000);
    const page1 = [page0[page0.length - 1]!, { id: "T-overlap-tail", title: "tail", updated: "2026-01-01T00:00:00.000Z", messageCount: 0 }];
    const offsets: number[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offset = Number(args[args.indexOf("--offset") + 1]); offsets.push(offset);
        return { ok: true, stdout: JSON.stringify(offset === 0 ? page0 : page1) };
      }
      return { ok: false, reason: "command_failed" };
    };
    const result = await readAmp({ machine: MACHINE_A, now: NOW, ampRunner: runner, ampSleep: noSleep, shouldParseSession: () => false });
    expect(offsets).toEqual([0, AMP_LIST_PAGE_STRIDE]);
    expect(result.diagnostics.some((d) => diagnosticName(d) === "amp.list.boundary_mismatch")).toBe(false);
  });

  test.each(["insertion", "deletion"])("boundary %s aborts before exports", async (_kind) => {
    const page0 = makeListPage(0, Date.parse("2026-07-20T12:00:00.000Z"), 60_000);
    let exports = 0;
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offset = Number(args[args.indexOf("--offset") + 1]);
        return { ok: true, stdout: JSON.stringify(offset === 0 ? page0 : [{ ...page0[page0.length - 1]!, id: `T-mismatch-${_kind}` }]) };
      }
      if (args[0] === "threads" && args[1] === "export") exports += 1;
      return { ok: false, reason: "command_failed" };
    };
    const result = await readAmp({ machine: MACHINE_A, now: NOW, ampRunner: runner, ampSleep: noSleep });
    expect(exports).toBe(0);
    expect(result.diagnostics.find((d) => diagnosticName(d) === "amp.list.boundary_mismatch")?.status).toBe("error");
  });
  test("walks every full page to the terminal page before fingerprint filtering", async () => {
    // The timestamps cross what used to be the early-stop cutoff. A complete
    // walk must still request the terminal page so older normalization
    // versions can reach shouldParseSession.
    const watermark = "2026-07-15T12:00:00.000Z";
    const cutoffMs = Date.parse(watermark) - 60 * 60 * 1_000;
    const GUARD_THREAD_ID = "T-selected-guard";

    // Page 0: newest at Jul 20, step 5min → oldest still well above cutoff.
    const page0Start = Date.parse("2026-07-20T12:00:00.000Z");
    // Page 1: starts just below page0's oldest, ends below cutoff.
    const page0Oldest = page0Start - (AMP_LIST_PAGE_SIZE - 1) * 5 * 60 * 1_000;
    const page1Start = page0Oldest - 5 * 60 * 1_000;
    // Ensure page1 oldest is below cutoff by using a larger step.
    const page1Step = Math.max(
      5 * 60 * 1_000,
      Math.ceil((page1Start - (cutoffMs - 2 * 60 * 60 * 1_000)) / (AMP_LIST_PAGE_SIZE - 1)),
    );

    const page0 = makeListPage(0, page0Start, 5 * 60 * 1_000);
    const page1 = overlapFullPage(
      page0,
      makeListPage(1, page1Start, page1Step),
    );
    const page1LastUpdated = Date.parse(
      (page1[page1.length - 1] as { updated: string }).updated,
    );
    const page2Start = page1LastUpdated - 5 * 60 * 1_000;
    const page2 = overlapFullPage(
      page1,
      makeListPage(2, page2Start, 5 * 60 * 1_000, [{
        id: GUARD_THREAD_ID,
        updated: new Date(page2Start - 60_000).toISOString(),
      }]),
    );

    // Sanity: page1 oldest is below cutoff so early-stop triggers.
    const page1Oldest = Date.parse((page1[page1.length - 1] as { updated: string }).updated);
    expect(page1Oldest).toBeLessThan(cutoffMs);
    const page0OldestActual = Date.parse(
      (page0[page0.length - 1] as { updated: string }).updated,
    );
    expect(page0OldestActual).toBeGreaterThanOrEqual(cutoffMs);

    const offsets: number[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offsetIndex = args.indexOf("--offset");
        const offset = offsetIndex >= 0 ? Number(args[offsetIndex + 1]) : 0;
        offsets.push(offset);
        if (offset === 0) return { ok: true, stdout: JSON.stringify(page0) };
        if (offset === AMP_LIST_PAGE_STRIDE) {
          return { ok: true, stdout: JSON.stringify(page1) };
        }
        if (offset === AMP_LIST_PAGE_STRIDE * 2) {
          return { ok: true, stdout: JSON.stringify(page2) };
        }
        // Terminal overlap-only page.
        return { ok: true, stdout: JSON.stringify([page2[page2.length - 1]]) };
      }
      if (args[0] === "threads" && args[1] === "export") {
        const id = args[2] ?? "";
        return {
          ok: true,
          stdout: JSON.stringify({
            v: 24,
            id,
            messages: [{ role: "assistant", content: [{ type: "text", text: "later page retained" }] }],
            created: 1_746_000_000_000,
          }),
        };
      }
      return { ok: false, reason: "command_failed" };
    };

    // Only export one later-page thread so we can assert it was enumerated
    // without exporting ~1000 other threads.
    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      shouldParseSession: (probe) =>
        probe.sessionId === sessionIdFor("amp", AmpSessionId(GUARD_THREAD_ID)),
    });

    expect(offsets).toEqual([
      0,
      AMP_LIST_PAGE_STRIDE,
      AMP_LIST_PAGE_STRIDE * 2,
      AMP_LIST_PAGE_STRIDE * 3,
    ]);
    expect(result.sessions.map((session) => session.nativeSessionId)).toEqual([GUARD_THREAD_ID]);
  });

  test("walks all overlapping pages to a short terminal page", async () => {
    const watermark = "2026-07-15T12:00:00.000Z";
    const cutoffMs = Date.parse(watermark) - 60 * 60 * 1_000;
    const page0Start = Date.parse("2026-07-20T12:00:00.000Z");
    const page0Oldest = page0Start - (AMP_LIST_PAGE_SIZE - 1) * 5 * 60 * 1_000;
    const page1Start = page0Oldest - 5 * 60 * 1_000;
    const page1Step = Math.max(
      5 * 60 * 1_000,
      Math.ceil((page1Start - (cutoffMs - 2 * 60 * 60 * 1_000)) / (AMP_LIST_PAGE_SIZE - 1)),
    );
    const page0 = makeListPage(0, page0Start, 5 * 60 * 1_000);
    const page1 = overlapFullPage(
      page0,
      makeListPage(1, page1Start, page1Step),
    );
    // Page 2 continues with more threads — only fetched when watermark is absent.
    const page2 = overlapFullPage(
      page1,
      makeListPage(
        2,
        Date.parse((page1[page1.length - 1] as { updated: string }).updated) - 5 * 60 * 1_000,
        5 * 60 * 1_000,
      ),
    );
    // Short terminal page.
    const page3 = [
      page2[page2.length - 1]!,
      {
        id: "T-force-tail",
        title: "Force tail",
        updated: "2026-01-01T00:00:00.000Z",
        tree: "file:///Users/dev/projects/old",
        messageCount: 1,
      },
    ];

    const offsets: number[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offsetIndex = args.indexOf("--offset");
        const offset = offsetIndex >= 0 ? Number(args[offsetIndex + 1]) : 0;
        offsets.push(offset);
        if (offset === 0) return { ok: true, stdout: JSON.stringify(page0) };
        if (offset === AMP_LIST_PAGE_STRIDE) {
          return { ok: true, stdout: JSON.stringify(page1) };
        }
        if (offset === AMP_LIST_PAGE_STRIDE * 2) {
          return { ok: true, stdout: JSON.stringify(page2) };
        }
        if (offset === AMP_LIST_PAGE_STRIDE * 3) {
          return { ok: true, stdout: JSON.stringify(page3) };
        }
        return { ok: true, stdout: JSON.stringify([]) };
      }
      return { ok: false, reason: "command_failed" };
    };

    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      shouldParseSession: () => false,
    });

    expect(offsets).toEqual([
      0,
      AMP_LIST_PAGE_STRIDE,
      AMP_LIST_PAGE_STRIDE * 2,
      AMP_LIST_PAGE_STRIDE * 3,
    ]);
    expect(result.sessions).toHaveLength(0);
  });

  test("list ordering does not affect complete enumeration", async () => {
    // Full page deliberately NOT updated-descending.
    const scrambled = Array.from({ length: AMP_LIST_PAGE_SIZE }, (_, i) => ({
      id: `T-scram-${i}`,
      title: `scram ${i}`,
      // Ascending order — violates the contract.
      updated: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60_000).toISOString(),
      tree: "file:///Users/dev/projects/widget",
      messageCount: 1,
    }));
    const shortTail = [
      scrambled[scrambled.length - 1]!,
      {
        id: "T-after-scram",
        title: "after",
        updated: "2026-07-20T12:00:00.000Z",
        tree: "file:///Users/dev/projects/widget",
        messageCount: 1,
      },
    ];

    const offsets: number[] = [];
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offsetIndex = args.indexOf("--offset");
        const offset = offsetIndex >= 0 ? Number(args[offsetIndex + 1]) : 0;
        offsets.push(offset);
        if (offset === 0) return { ok: true, stdout: JSON.stringify(scrambled) };
        if (offset === AMP_LIST_PAGE_STRIDE) {
          return { ok: true, stdout: JSON.stringify(shortTail) };
        }
        return { ok: true, stdout: JSON.stringify([]) };
      }
      if (args[0] === "threads" && args[1] === "export") {
        return {
          ok: true,
          stdout: JSON.stringify({
            v: 24,
            id: args[2],
            messages: [],
            created: 1_746_000_000_000,
          }),
        };
      }
      return { ok: false, reason: "command_failed" };
    };

    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      shouldParseSession: (probe) =>
        probe.sessionId === sessionIdFor("amp", AmpSessionId("T-after-scram")),
    });

    expect(offsets).toEqual([0, AMP_LIST_PAGE_STRIDE]);
    expect(result.sessions.map((session) => session.nativeSessionId)).toEqual(["T-after-scram"]);
  });

  test("page cap emits amp.list.page_cap_reached (truncated walk is observable)", async () => {
    // Tests inject a tiny cap so a truncated walk is cheap. Production has no
    // page cap and walks until a terminal page.
    const cap = 2;
    const offsets: number[] = [];
    let exports = 0;
    const page0 = makeListPage(0, Date.parse("2026-07-20T12:00:00.000Z"), 60_000);
    const page1 = overlapFullPage(
      page0,
      makeListPage(
        1,
        Date.parse((page0[page0.length - 1] as { updated: string }).updated) - 60_000,
        60_000,
      ),
    );
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offsetIndex = args.indexOf("--offset");
        const offset = offsetIndex >= 0 ? Number(args[offsetIndex + 1]) : 0;
        offsets.push(offset);
        return { ok: true, stdout: JSON.stringify(offset === 0 ? page0 : page1) };
      }
      if (args[0] === "threads" && args[1] === "export") {
        exports += 1;
        return { ok: true, stdout: JSON.stringify(recentExport) };
      }
      return { ok: false, reason: "command_failed" };
    };

    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      maxListPages: cap,
      limit: 1,
    });

    expect(offsets).toEqual([0, AMP_LIST_PAGE_STRIDE]);
    expect(result.diagnostics.find((d) => diagnosticName(d) === "amp.list.page_cap_reached")?.status).toBe("error");
    expect(exports).toBe(0);
    expect(result.sessions).toHaveLength(0);
  });

  test("short terminal page is a complete walk (no page_cap_reached)", async () => {
    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: fixtureRunner(),
      ampSleep: noSleep,
      exportSpacingMs: 0,
      maxListPages: 2,
      shouldParseSession: () => false,
    });
    expect(
      result.diagnostics.some((d) => diagnosticName(d) === "amp.list.page_cap_reached"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema unit
// ---------------------------------------------------------------------------

describe("amp-schema decode", () => {
  test("list entry and export schemas accept measured fixtures", () => {
    const entry = Schema.decodeUnknownEither(AmpThreadListEntrySchema)(listPage[0]);
    expect(entry._tag).toBe("Right");
    const exported = Schema.decodeUnknownEither(AmpExportSchema)(recentExport);
    expect(exported._tag).toBe("Right");
  });

  test("empty id list entry fails closed", () => {
    const bad = Schema.decodeUnknownEither(AmpThreadListEntrySchema)({
      id: "",
      updated: "2026-07-20T12:00:00.000Z",
    });
    expect(bad._tag).toBe("Left");
  });

  test("export requires a nonempty id and messages array", () => {
    expect(Schema.decodeUnknownEither(AmpExportSchema)({})._tag).toBe("Left");
    expect(Schema.decodeUnknownEither(AmpExportSchema)({ id: THREAD_A })._tag).toBe("Left");
    expect(Schema.decodeUnknownEither(AmpExportSchema)({ id: "", messages: [] })._tag).toBe("Left");
  });
});
