import { describe, expect, test } from "vitest";

import { ampAdapter } from "../src/adapters/amp";
import type { AmpRunner } from "../src/adapters/amp";
import { buildSession } from "../src/adapters/common";

// ---------------------------------------------------------------------------
// Machine identities — two DIFFERENT machines must converge on one session id.
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

const NOW = "2026-06-16T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Hand-authored captured-shape fixtures. No network: a fake runner returns
// these in response to `threads list` / `threads export`.
// ---------------------------------------------------------------------------

const RECENT_THREAD_ID = "T-recent-0001";
const OLD_THREAD_ID = "T-old-0002";

const listPage = [
  {
    id: RECENT_THREAD_ID,
    title: "Recent thread",
    updated: "2026-05-01T12:00:00.000Z",
    messageCount: 4,
  },
  {
    id: OLD_THREAD_ID,
    title: "Old thread",
    updated: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
  },
];

/** A captured-shape export with text, thinking, tool_use + tool_result. */
const recentExport = {
  v: 7,
  env: {
    initial: {
      trees: [{ uri: "file:///Users/dev/projects/widget" }],
    },
  },
  meta: { agentMode: "claude-sonnet" },
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
          startTime: 1_746_100_001_000,
          finalTime: 1_746_100_002_000,
          provider: "openai",
          openAIReasoning: {
            encryptedContent: "ENCRYPTED-OPAQUE-BLOB-SHOULD-NEVER-SURFACE",
          },
        },
        {
          type: "text",
          text: "Let me read the widget file.",
          startTime: 1_746_100_002_000,
          finalTime: 1_746_100_003_000,
        },
        {
          type: "tool_use",
          id: "TU-aaa",
          name: "read_file",
          input: { path: "src/widget.ts" },
          startTime: 1_746_100_003_000,
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
          },
        },
      ],
    },
  ],
};

/** A runner that answers from the in-memory fixtures. */
const fixtureRunner: AmpRunner = (args) => {
  if (args[0] === "threads" && args[1] === "list") {
    const offsetIndex = args.indexOf("--offset");
    const offset = offsetIndex >= 0 ? Number(args[offsetIndex + 1]) : 0;
    // Single short page → loop terminates after first request.
    return { ok: true, stdout: JSON.stringify(offset === 0 ? listPage : []) };
  }
  if (args[0] === "threads" && args[1] === "export") {
    if (args[2] === RECENT_THREAD_ID) return { ok: true, stdout: JSON.stringify(recentExport) };
    return { ok: true, stdout: JSON.stringify({ v: 7, messages: [] }) };
  }
  return { ok: false, reason: "command_failed" };
};

const readAmp = (machine: typeof MACHINE_A, runner: AmpRunner = fixtureRunner) =>
  ampAdapter.read({ machine, now: NOW, ampRunner: runner } as Parameters<
    typeof ampAdapter.read
  >[0]);

// ---------------------------------------------------------------------------
// (a) machine-independent canonical id + local-provider regression guard
// ---------------------------------------------------------------------------

describe("machine-independent canonical identity", () => {
  test("canonicalId is byte-identical across two different machines", async () => {
    const a = await readAmp(MACHINE_A);
    const b = await readAmp(MACHINE_B);
    expect(a.sessions).toHaveLength(1);
    expect(b.sessions).toHaveLength(1);
    expect(a.sessions[0]!.id).toBe(b.sessions[0]!.id);
    // The id derives from the thread URL alone, never the machine.
    expect(a.sessions[0]!.id).not.toContain(MACHINE_A.machineId);
    expect(b.sessions[0]!.id).not.toContain(MACHINE_B.machineId);
  });

  test("a local-provider buildSession id is UNCHANGED by the canonicalId addition", () => {
    // Regression guard: omitting canonicalId must reproduce the legacy id that
    // hashes (nativeSessionId, sourcePath) with machineId in the prefix.
    const local = buildSession({
      provider: "grok",
      agentName: "grok-build",
      machine: MACHINE_A,
      nativeSessionId: "session-xyz",
      sourceRoot: "/root",
      sourcePath: "/root/session-xyz",
      events: [],
    });
    // The known byte-identical shape: provider:machineId:<hash>
    expect(local.id.startsWith(`grok:${MACHINE_A.machineId}:`)).toBe(true);
    // And a second build with the same inputs is identical.
    const again = buildSession({
      provider: "grok",
      agentName: "grok-build",
      machine: MACHINE_A,
      nativeSessionId: "session-xyz",
      sourceRoot: "/root",
      sourcePath: "/root/session-xyz",
      events: [],
    });
    expect(again.id).toBe(local.id);
  });
});

// ---------------------------------------------------------------------------
// (b) recent-thread scope filter
// ---------------------------------------------------------------------------

describe("recent-thread scope", () => {
  test("a thread updated before the cutoff is excluded; recent included", async () => {
    const result = await readAmp(MACHINE_A);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.nativeSessionId).toBe(RECENT_THREAD_ID);
  });
});

// ---------------------------------------------------------------------------
// (c) fingerprint tag stability
// ---------------------------------------------------------------------------

describe("list-metadata fingerprint tag", () => {
  const collectFingerprint = async (
    updated: string,
    messageCount: number,
  ): Promise<string> => {
    const runner: AmpRunner = (args) => {
      if (args[0] === "threads" && args[1] === "list") {
        const offsetIndex = args.indexOf("--offset");
        const offset = offsetIndex >= 0 ? Number(args[offsetIndex + 1]) : 0;
        return {
          ok: true,
          stdout: JSON.stringify(
            offset === 0 ? [{ id: RECENT_THREAD_ID, updated, messageCount }] : [],
          ),
        };
      }
      return { ok: true, stdout: JSON.stringify(recentExport) };
    };
    let captured: string | undefined;
    await ampAdapter.read({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      shouldParseSession: (probe) => {
        captured = probe.sourceFingerprint;
        return true;
      },
    } as Parameters<typeof ampAdapter.read>[0]);
    return captured!;
  };

  test("tag stable iff (updated, messageCount) unchanged", async () => {
    const base = await collectFingerprint("2026-05-01T12:00:00.000Z", 4);
    const same = await collectFingerprint("2026-05-01T12:00:00.000Z", 4);
    const changedUpdated = await collectFingerprint("2026-05-02T12:00:00.000Z", 4);
    const changedCount = await collectFingerprint("2026-05-01T12:00:00.000Z", 5);
    expect(same).toBe(base);
    expect(changedUpdated).not.toBe(base);
    expect(changedCount).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// (d) tool_use + tool_result → one linked, completed ToolCall
// ---------------------------------------------------------------------------

describe("tool linkage", () => {
  test("tool_use and tool_result merge into a single completed ToolCall", async () => {
    const result = await readAmp(MACHINE_A);
    const session = result.sessions[0]!;
    expect(session.toolCalls).toHaveLength(1);
    const toolCall = session.toolCalls[0]!;
    expect(toolCall.toolName).toBe("read_file");
    expect(toolCall.status).toBe("completed");
    expect(JSON.stringify(toolCall.input)).toContain("src/widget.ts");
    expect(JSON.stringify(toolCall.output)).toContain("export const widget");

    // Both the tool_call and tool_result events reference the same ToolCall id.
    const linked = session.events.filter((e) => e.toolCallId === toolCall.id);
    expect(linked.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// (e) thinking → reasoning, encrypted blob never present
// ---------------------------------------------------------------------------

describe("thinking → reasoning, no encrypted blob", () => {
  test("thinking block becomes a reasoning event and the encrypted blob is dropped", async () => {
    const result = await readAmp(MACHINE_A);
    const session = result.sessions[0]!;
    const reasoning = session.events.filter((e) => e.role === "thinking" && e.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.contentText).toContain("inspect the file first");

    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("ENCRYPTED-OPAQUE-BLOB-SHOULD-NEVER-SURFACE");
    expect(serialized).not.toContain("encryptedContent");
  });
});

// ---------------------------------------------------------------------------
// (f) project from trees[].uri → a git:/path identity key
// ---------------------------------------------------------------------------

describe("project mapping", () => {
  test("file:/// tree uri yields a project identity key", async () => {
    const result = await readAmp(MACHINE_A);
    const session = result.sessions[0]!;
    expect(session.projectIdentity.projectIdentityKey.length).toBeGreaterThan(0);
    // The raw workdir is carried through the identity ladder.
    const raw = session.projectIdentity.rawPath ?? session.projectIdentity.normalizedPath ?? "";
    expect(raw).toContain("widget");
  });
});

// ---------------------------------------------------------------------------
// (g) subprocess failure → named diagnostic, zero sessions, no throw
// ---------------------------------------------------------------------------

describe("fail-soft on subprocess failure", () => {
  test("a failing list runner yields zero sessions and a named diagnostic", async () => {
    const failingRunner: AmpRunner = () => ({ ok: false, reason: "command_failed" });
    const result = await readAmp(MACHINE_A, failingRunner);
    expect(result.sessions).toHaveLength(0);
    const unavailable = result.diagnostics.filter((d) => d.status === "error");
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
  });

  test("a missing binary yields zero sessions and a named diagnostic", async () => {
    const missingRunner: AmpRunner = () => ({ ok: false, reason: "missing_binary" });
    const result = await readAmp(MACHINE_A, missingRunner);
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.status === "error")).toBe(true);
  });
});
