import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  AMP_LIST_PAGE_SIZE,
  ampAdapter,
  readAmp,
  type AmpRunner,
  type AmpStreamOptions,
} from "../src/adapters/amp";
import { AmpExportSchema, AmpThreadListEntrySchema } from "../src/adapters/amp-schema";
import { sessionIdFor } from "../src/adapters/common";
import { adaptersByProvider, stableAdapters } from "../src/adapters/registry";
import { AmpSessionId } from "../src/core/identity";
import { NormalizedSession } from "../src/core/schemas";
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

describe("amp registry gating", () => {
  test("amp is resolvable by provider key but excluded from stableAdapters / all", () => {
    expect(adaptersByProvider.get("amp")).toBe(ampAdapter);
    expect(stableAdapters.map((adapter) => adapter.provider)).not.toContain("amp");
    expect(ampAdapter.stable).toBe(false);
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

    const decoded = Schema.decodeUnknownEither(NormalizedSession)(session);
    expect(decoded._tag).toBe("Right");

    const reasoning = session.events.filter((event) => event.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.role).toBe("thinking");
    expect(reasoning[0]!.contentText).toContain("inspect the file first");

    expect(session.toolCalls).toHaveLength(1);
    const toolCall = session.toolCalls[0]!;
    expect(toolCall.toolName).toBe("read_file");
    expect(toolCall.status).toBe("completed");
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
    expect(mapped.session.sessionId).toBe(sessionItem.session.id);
    expect(mapped.session.sourceFingerprint).toBe(fingerprint);
    expect(mapped.messages.length).toBeGreaterThan(0);
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
});

// ---------------------------------------------------------------------------
// Watermark pagination
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
  // Re-sort desc by updated so the page remains order-sound for early-stop.
  entries.sort((left, right) => {
    const leftMs = Date.parse((left as { updated: string }).updated);
    const rightMs = Date.parse((right as { updated: string }).updated);
    return rightMs - leftMs;
  });
  return entries;
};

const diagnosticName = (d: { details?: unknown }): string | undefined => {
  if (d.details === undefined || typeof d.details !== "object" || d.details === null) {
    return undefined;
  }
  const name = (d.details as { diagnostic?: unknown }).diagnostic;
  return typeof name === "string" ? name : undefined;
};

describe("amp highWatermark pagination", () => {
  test("multi-page: trigger page + exactly one guard page, then stop; in-window guard thread enumerated", async () => {
    // Watermark W; cutoff = W - 60m. Page 0 stays above cutoff; page 1's oldest
    // falls below cutoff (triggers stop); page 2 is the single guard page.
    const watermark = "2026-07-15T12:00:00.000Z";
    const cutoffMs = Date.parse(watermark) - 60 * 60 * 1_000;
    const GUARD_IN_WINDOW_ID = "T-guard-in-window";
    const GUARD_IN_WINDOW_UPDATED = new Date(cutoffMs + 30 * 60 * 1_000).toISOString();

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
    const page1 = makeListPage(1, page1Start, page1Step);
    // Guard page: short page including a thread still inside the window.
    const page2 = [
      {
        id: GUARD_IN_WINDOW_ID,
        title: "Guard in-window thread",
        updated: GUARD_IN_WINDOW_UPDATED,
        tree: "file:///Users/dev/projects/widget",
        messageCount: 1,
      },
      {
        id: "T-guard-old",
        title: "Guard old thread",
        updated: new Date(cutoffMs - 3 * 60 * 60 * 1_000).toISOString(),
        tree: "file:///Users/dev/projects/old",
        messageCount: 1,
      },
    ];

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
        if (offset === AMP_LIST_PAGE_SIZE) {
          return { ok: true, stdout: JSON.stringify(page1) };
        }
        if (offset === AMP_LIST_PAGE_SIZE * 2) {
          return { ok: true, stdout: JSON.stringify(page2) };
        }
        // Must not be requested after guard page.
        return { ok: true, stdout: JSON.stringify([]) };
      }
      if (args[0] === "threads" && args[1] === "export") {
        const id = args[2] ?? "";
        return {
          ok: true,
          stdout: JSON.stringify({ v: 24, id, messages: [], created: 1_746_000_000_000 }),
        };
      }
      return { ok: false, reason: "command_failed" };
    };

    // Only export the in-window guard thread so we can assert it was enumerated
    // without exporting ~1000 other threads.
    const result = await readAmp({
      machine: MACHINE_A,
      now: NOW,
      ampRunner: runner,
      ampSleep: noSleep,
      exportSpacingMs: 0,
      highWatermark: watermark,
      shouldParseSession: (probe) =>
        probe.sessionId === sessionIdFor("amp", AmpSessionId(GUARD_IN_WINDOW_ID)),
    });

    expect(offsets).toEqual([0, AMP_LIST_PAGE_SIZE, AMP_LIST_PAGE_SIZE * 2]);
    expect(result.diagnostics.some((d) => diagnosticName(d) === "amp.list.early_stop")).toBe(
      true,
    );
    expect(result.sessions.map((s) => s.nativeSessionId)).toEqual([GUARD_IN_WINDOW_ID]);
  });

  test("without highWatermark (force path) walks past where early-stop would cut", async () => {
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
    const page1 = makeListPage(1, page1Start, page1Step);
    // Page 2 continues with more threads — only fetched when watermark is absent.
    const page2 = makeListPage(
      2,
      Date.parse((page1[page1.length - 1] as { updated: string }).updated) - 5 * 60 * 1_000,
      5 * 60 * 1_000,
    );
    // Short terminal page.
    const page3 = [
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
        if (offset === AMP_LIST_PAGE_SIZE) {
          return { ok: true, stdout: JSON.stringify(page1) };
        }
        if (offset === AMP_LIST_PAGE_SIZE * 2) {
          return { ok: true, stdout: JSON.stringify(page2) };
        }
        if (offset === AMP_LIST_PAGE_SIZE * 3) {
          return { ok: true, stdout: JSON.stringify(page3) };
        }
        return { ok: true, stdout: JSON.stringify([]) };
      }
      return { ok: false, reason: "command_failed" };
    };

    // No highWatermark — same as ingest --force for Amp.
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
      AMP_LIST_PAGE_SIZE,
      AMP_LIST_PAGE_SIZE * 2,
      AMP_LIST_PAGE_SIZE * 3,
    ]);
    expect(result.diagnostics.some((d) => diagnosticName(d) === "amp.list.early_stop")).toBe(
      false,
    );
    expect(result.sessions).toHaveLength(0);
  });

  test("non-descending list page disables early-stop and emits order diagnostic", async () => {
    const watermark = "2026-07-15T12:00:00.000Z";
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
        if (offset === AMP_LIST_PAGE_SIZE) {
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
      highWatermark: watermark,
      shouldParseSession: (probe) =>
        probe.sessionId === sessionIdFor("amp", AmpSessionId("T-after-scram")),
    });

    // Early-stop disabled → walks to short page (offset 500), not stop after page 0.
    expect(offsets).toEqual([0, AMP_LIST_PAGE_SIZE]);
    expect(
      result.diagnostics.some((d) => diagnosticName(d) === "amp.list.order_not_descending"),
    ).toBe(true);
    expect(result.diagnostics.some((d) => diagnosticName(d) === "amp.list.early_stop")).toBe(
      false,
    );
    expect(result.sessions.map((s) => s.nativeSessionId)).toEqual(["T-after-scram"]);
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
});
