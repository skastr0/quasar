import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { codexAdapter } from "../src/adapters/codex";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-11T00:00:00.000Z";

const line = (value: unknown) => JSON.stringify(value);

const rolloutLines = (cwd: string) =>
  [
    line({
      timestamp: NOW,
      type: "session_meta",
      payload: { type: "session_meta", id: "native", cwd },
    }),
    // Injected wrapper arriving with role user — must map to kind preamble.
    line({
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }],
      },
    }),
    // Real human turn.
    line({
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "please fix the bug" }],
      },
    }),
    // event_msg duplicate of the same turn.
    line({
      timestamp: NOW,
      type: "event_msg",
      payload: { type: "user_message", message: "please fix the bug" },
    }),
    // Encrypted reasoning — content must be stripped by projection.
    line({
      timestamp: NOW,
      type: "response_item",
      payload: { type: "reasoning", summary: [], encrypted_content: "gAAAAAB-cipher" },
    }),
    // function_call pair.
    line({
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call_fn",
        name: "shell",
        arguments: '{"command":["ls"]}',
      },
    }),
    line({
      timestamp: NOW,
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_fn", output: "file.txt" },
    }),
    // custom_tool_call pair (apply_patch carries raw text in `input`).
    line({
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "call_patch",
        name: "apply_patch",
        status: "completed",
        input: "*** Begin Patch\n*** Update File: /tmp/a.ts\n*** End Patch",
      },
    }),
    line({
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_patch",
        output: "Success. Updated the following files:\nM /tmp/a.ts",
      },
    }),
    // Assistant reply.
    line({
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done, the bug is fixed" }],
      },
    }),
  ].join("\n");

const root = mkdtempSync(join(tmpdir(), "quasar-codex-adapter-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("codex adapter", () => {
  test("scans sessions/ (dated tree) and archived_sessions/ (flat) as one estate", async () => {
    const datedDir = join(root, "sessions", "2026", "06", "11");
    const archivedDir = join(root, "archived_sessions");
    mkdirSync(datedDir, { recursive: true });
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(datedDir, "rollout-2026-06-11-live.jsonl"), rolloutLines("/tmp/proj"));
    writeFileSync(join(archivedDir, "rollout-2026-05-01-archived.jsonl"), rolloutLines("/tmp/proj"));

    const result = await codexAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { codex: root },
    });

    expect(result.sessions).toHaveLength(2);
    expect(result.sourceRoots.map((sourceRoot) => sourceRoot.rootPath)).toEqual([
      join(root, "sessions"),
      join(root, "archived_sessions"),
    ]);
    const sourcePaths = result.sessions.map((session) => session.sourcePath).sort();
    expect(sourcePaths[0]).toContain("archived_sessions");
    expect(sourcePaths[1]).toContain(join("sessions", "2026"));
    // Distinct sourcePath prefixes mean distinct session ids — idempotency safe.
    expect(new Set(result.sessions.map((session) => session.id)).size).toBe(2);
  });

  test("maps wrappers to preamble, keeps human turns as messages, strips encrypted reasoning", async () => {
    const result = await codexAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { codex: root },
      limit: 1,
    });
    const session = result.sessions[0]!;

    // Provenance: host carries the readable machine hostname (not the id), and
    // every session is stamped with the canonical identity scheme version.
    expect(session.host).toBe("test-host");
    expect(session.identitySchemeVersion).toBe(1);

    const wrapper = session.events.find((event) =>
      event.rawReference.line === 2,
    )!;
    expect(wrapper.kind).toBe("preamble");

    const humanTurn = session.events.find((event) => event.rawReference.line === 3)!;
    expect(humanTurn.kind).toBe("message");
    expect(humanTurn.role).toBe("user");

    const reasoning = session.events.find((event) => event.kind === "reasoning")!;
    expect(reasoning.role).toBe("thinking");
    expect(JSON.stringify(reasoning)).not.toContain("gAAAAAB");

    const assistantTurn = session.events.find(
      (event) => event.kind === "message" && event.role === "assistant",
    )!;
    expect(assistantTurn.contentBlocks.some((block) => "text" in block)).toBe(true);
  });

  test("maps the full injected-wrapper family to preamble (measured 2026-06-11)", async () => {
    const wrapperDir = join(root, "sessions", "2026", "06", "12");
    mkdirSync(wrapperDir, { recursive: true });
    const wrapperTexts = [
      "<permissions instructions>\nFilesystem sandboxing defines which files…",
      "<skills_instructions>\n## Skills\nA skill is a set of local instructions…",
      "<apps_instructions>\n## Apps (Connectors)…",
      "<plugins_instructions>\n## Plugins…",
      "<collaboration_mode># Collaboration Mode: Default…",
      "<personality_spec> The user has requested a new communication style…",
      "<model_switch>\nThe user was previously using a different model…",
      "<app-context>\n# Codex desktop context…",
    ];
    writeFileSync(
      join(wrapperDir, "rollout-2026-06-12-wrappers.jsonl"),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { type: "session_meta", id: "wrappers", cwd: "/tmp/proj" },
        }),
        ...wrapperTexts.map((text) =>
          line({
            timestamp: NOW,
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }],
            },
          }),
        ),
        line({
          timestamp: NOW,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "real question from a human" }],
          },
        }),
      ].join("\n"),
    );

    const result = await codexAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { codex: root },
    });
    const session = result.sessions.find((candidate) =>
      candidate.sourcePath.endsWith("rollout-2026-06-12-wrappers.jsonl"),
    )!;
    const messageEvents = session.events.filter((event) => event.kind === "message");
    expect(messageEvents).toHaveLength(1);
    expect(JSON.stringify(messageEvents[0]!.contentBlocks)).toContain(
      "real question from a human",
    );
    expect(
      session.events.filter((event) => event.kind === "preamble"),
    ).toHaveLength(wrapperTexts.length);
  });

  test("empty text stubs carry no turn content — no JSON envelope dump (measured 2026-06-11)", async () => {
    const stubDir = join(root, "sessions", "2026", "06", "14");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(
      join(stubDir, "rollout-2026-06-14-stubs.jsonl"),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { type: "session_meta", id: "stubs", cwd: "/tmp/proj" },
        }),
        // The measured corpus shape: an assistant message whose entire
        // content is one empty output_text stub. Provider machinery, not a turn.
        line({
          timestamp: NOW,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "" }],
          },
        }),
        line({
          timestamp: NOW,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a real reply" }],
          },
        }),
      ].join("\n"),
    );

    const result = await codexAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { codex: root },
    });
    const session = result.sessions.find((candidate) =>
      candidate.sourcePath.endsWith("rollout-2026-06-14-stubs.jsonl"),
    )!;
    const stubEvent = session.events.find((event) => event.rawReference.line === 2)!;
    expect(stubEvent.kind).toBe("message");
    expect(stubEvent.contentText).toBeUndefined();
    expect(stubEvent.contentBlocks).toHaveLength(0);
    expect(JSON.stringify(stubEvent)).not.toContain('{\\"type\\":\\"output_text\\"}');
    const realEvent = session.events.find((event) => event.rawReference.line === 3)!;
    expect(realEvent.contentBlocks.map((block) => [block.kind, block.text])).toEqual([
      ["text", "a real reply"],
    ]);
  });

  test("merges local_shell_call pairs into completed tool calls (input from `action`)", async () => {
    const shellDir = join(root, "sessions", "2026", "06", "13");
    mkdirSync(shellDir, { recursive: true });
    writeFileSync(
      join(shellDir, "rollout-2026-06-13-local-shell.jsonl"),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { type: "session_meta", id: "local-shell", cwd: "/tmp/proj" },
        }),
        line({
          timestamp: NOW,
          type: "response_item",
          payload: {
            type: "local_shell_call",
            call_id: "call_shell",
            status: "completed",
            action: { type: "exec", command: ["bash", "-lc", "ls"] },
          },
        }),
        line({
          timestamp: NOW,
          type: "response_item",
          payload: { type: "local_shell_call_output", call_id: "call_shell", output: "file.txt" },
        }),
      ].join("\n"),
    );

    const result = await codexAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { codex: root },
    });
    const session = result.sessions.find((candidate) =>
      candidate.sourcePath.endsWith("rollout-2026-06-13-local-shell.jsonl"),
    )!;

    expect(session.toolCalls).toHaveLength(1);
    const shell = session.toolCalls[0]!;
    expect(shell.toolName).toBe("local_shell");
    expect(shell.status).toBe("completed");
    expect(JSON.stringify(shell.input)).toContain("bash");
    expect(JSON.stringify(shell.output)).toContain("file.txt");

    const kinds = session.events
      .filter((event) => event.toolCallId !== undefined)
      .map((event) => event.kind);
    expect(kinds).toEqual(["tool_call", "tool_result"]);
  });

  test("merges function_call and custom_tool_call pairs into completed tool calls", async () => {
    const result = await codexAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { codex: root },
      limit: 1,
    });
    const session = result.sessions[0]!;
    expect(session.toolCalls).toHaveLength(2);

    const shell = session.toolCalls.find((toolCall) => toolCall.toolName === "shell")!;
    expect(shell.status).toBe("completed");
    expect(shell.output).toContain("file.txt");

    const patch = session.toolCalls.find((toolCall) => toolCall.toolName === "apply_patch")!;
    expect(patch.status).toBe("completed");
    expect(JSON.stringify(patch.input)).toContain("Begin Patch");
    expect(JSON.stringify(patch.output)).toContain("Updated the following files");

    // Tool-call/result events carry the kinds the ingest layer expects.
    const kinds = session.events
      .filter((event) => event.toolCallId !== undefined)
      .map((event) => event.kind);
    expect(kinds).toEqual(["tool_call", "tool_result", "tool_call", "tool_result"]);
  });

  // ---------------------------------------------------------------------------
  // AC#5 — idempotency proof
  //
  // Codex native id = filename stem of the source path. Two files at
  // DIFFERENT parent directories but carrying the SAME filename stem must
  // resolve to byte-identical session.id values.  The test reads the adapter
  // over two independent temp trees and asserts the resulting ids match.
  // ---------------------------------------------------------------------------
  test("AC#5 idempotency: same filename stem at different parent paths → byte-identical session.id", async () => {
    // Tree A simulates a host path (e.g. /Users/me/Library/…)
    const hostRoot = mkdtempSync(join(tmpdir(), "quasar-codex-host-"));
    // Tree B simulates a Docker /history mount
    const dockerRoot = mkdtempSync(join(tmpdir(), "quasar-codex-docker-"));

    try {
      // Both trees use the SAME filename, producing the same stem.
      const FILENAME = "rollout-2026-06-21-idem.jsonl";
      const hostDir = join(hostRoot, "sessions", "2026", "06", "21");
      const dockerDir = join(dockerRoot, "sessions", "2026", "06", "21");
      mkdirSync(hostDir, { recursive: true });
      mkdirSync(dockerDir, { recursive: true });

      // Identical content at both locations — same payload.id, same everything.
      const content = rolloutLines("/tmp/idem-proj");
      writeFileSync(join(hostDir, FILENAME), content);
      writeFileSync(join(dockerDir, FILENAME), content);

      const hostResult = await codexAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { codex: hostRoot },
      });
      const dockerResult = await codexAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { codex: dockerRoot },
      });

      expect(hostResult.sessions).toHaveLength(1);
      expect(dockerResult.sessions).toHaveLength(1);
      // The canonical session.id is the critical assertion: byte-identical
      // regardless of which parent directory tree the adapter scanned.
      expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
      // Sanity: the sourcePaths DO differ (they live in different trees).
      expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
      rmSync(dockerRoot, { recursive: true, force: true });
    }
  });
});
