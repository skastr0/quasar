import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { codexAdapter } from "../src/adapters/codex";
import { sessionIdFor } from "../src/adapters/common";
import { CodexSessionId } from "../src/core/identity";
import { mapSession } from "../src/map";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-11T00:00:00.000Z";

const line = (value: unknown) => JSON.stringify(value);

// Real on-disk shape: every rollout file is named
// rollout-<ISO datetime>-<uuidv7>.jsonl and its line 1 is a session_meta
// record whose payload.id is that same UUIDv7 (the codex native session id).
const FIXTURE_UUID = "01900000-0000-7000-8000-000000000001";
const rolloutFilename = (datetime: string, uuid: string) =>
  `rollout-${datetime}-${uuid}.jsonl`;

const rolloutLines = (cwd: string, id: string = FIXTURE_UUID) =>
  [
    // Real-shaped session_meta: payload.id is the bare UUIDv7 also embedded in
    // the filename; carries cwd/originator/cli_version as the real harness does.
    line({
      timestamp: NOW,
      type: "session_meta",
      payload: {
        id,
        timestamp: NOW,
        cwd,
        originator: "codex-tui",
        cli_version: "0.140.0",
        type: "session_meta",
      },
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
    // Distinct sessions carry distinct session_meta.payload.id values — the
    // content-sourced native id, NOT the filename stem.
    const liveUuid = "01900000-0000-7000-8000-000000000001";
    const archivedUuid = "01900000-0000-7000-8000-000000000002";
    writeFileSync(
      join(datedDir, rolloutFilename("2026-06-11T03-14-02", liveUuid)),
      rolloutLines("/tmp/proj", liveUuid),
    );
    writeFileSync(
      join(archivedDir, rolloutFilename("2026-05-01T09-00-00", archivedUuid)),
      rolloutLines("/tmp/proj", archivedUuid),
    );

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
    const wrapperUuid = "01900000-0000-7000-8000-000000000003";
    const wrapperFile = rolloutFilename("2026-06-12T10-00-00", wrapperUuid);
    writeFileSync(
      join(wrapperDir, wrapperFile),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { id: wrapperUuid, timestamp: NOW, cwd: "/tmp/proj", type: "session_meta" },
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
      candidate.sourcePath.endsWith(wrapperFile),
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
    const stubUuid = "01900000-0000-7000-8000-000000000004";
    const stubFile = rolloutFilename("2026-06-14T11-22-33", stubUuid);
    writeFileSync(
      join(stubDir, stubFile),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { id: stubUuid, timestamp: NOW, cwd: "/tmp/proj", type: "session_meta" },
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
      candidate.sourcePath.endsWith(stubFile),
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
    const shellUuid = "01900000-0000-7000-8000-000000000005";
    const shellFile = rolloutFilename("2026-06-13T08-15-00", shellUuid);
    writeFileSync(
      join(shellDir, shellFile),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { id: shellUuid, timestamp: NOW, cwd: "/tmp/proj", type: "session_meta" },
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
      candidate.sourcePath.endsWith(shellFile),
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
  // AC#5 — idempotency proof (content-sourced id)
  //
  // The codex native id is session_meta.payload.id — NOT the filename stem. To
  // prove the id is content-sourced and path/filename-INDEPENDENT, the two
  // files vary BOTH the parent directory AND the filename (different
  // rollout-<timestamp>-... names), while carrying the IDENTICAL
  // session_meta.payload.id. Their canonical session.id must be byte-identical.
  // This FAILS if codex ever reverts to deriving the id from the filename stem,
  // since the stems differ.
  // ---------------------------------------------------------------------------
  test("AC#5 idempotency: identical session_meta.payload.id under different parent paths AND filenames → byte-identical session.id", async () => {
    // Tree A simulates a host path (e.g. /Users/me/Library/…)
    const hostRoot = mkdtempSync(join(tmpdir(), "quasar-codex-host-"));
    // Tree B simulates a Docker /history mount
    const dockerRoot = mkdtempSync(join(tmpdir(), "quasar-codex-docker-"));

    try {
      // The SAME content id, the SAME canonical conversation.
      const SHARED_UUID = "01900000-0000-7000-8000-000000000006";
      // Different parent directories AND different rollout filenames (distinct
      // embedded timestamps): nothing path/filename-derived can match.
      const hostDir = join(hostRoot, "sessions", "2026", "06", "21");
      const dockerDir = join(dockerRoot, "sessions", "2026", "06", "20");
      mkdirSync(hostDir, { recursive: true });
      mkdirSync(dockerDir, { recursive: true });
      const hostFile = rolloutFilename("2026-06-21T07-00-00", SHARED_UUID);
      const dockerFile = rolloutFilename("2026-06-20T19-30-15", SHARED_UUID);

      // Same session_meta.payload.id at both locations; the filename timestamp
      // differs but is irrelevant to identity.
      const content = rolloutLines("/tmp/idem-proj", SHARED_UUID);
      writeFileSync(join(hostDir, hostFile), content);
      writeFileSync(join(dockerDir, dockerFile), content);

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
      // because it is sourced from session_meta.payload.id, not the path/stem.
      expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
      // Sanity: BOTH the sourcePaths and the filenames DO differ.
      expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
      expect(hostResult.sessions[0]!.sourcePath.endsWith(hostFile)).toBe(true);
      expect(dockerResult.sessions[0]!.sourcePath.endsWith(dockerFile)).toBe(true);
      expect(hostFile).not.toBe(dockerFile);
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
      rmSync(dockerRoot, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Boundary rejection: a rollout file whose line 1 carries no
  // session_meta.payload.id is a contract breach. The adapter must write ZERO
  // rows for it, emit the named diagnostic, and continue.
  // ---------------------------------------------------------------------------
  test("boundary-rejects a rollout file missing session_meta.payload.id", async () => {
    const rejectRoot = mkdtempSync(join(tmpdir(), "quasar-codex-reject-"));
    try {
      const dir = join(rejectRoot, "sessions", "2026", "06", "21");
      mkdirSync(dir, { recursive: true });
      // Line 1 is a session_meta with NO payload.id — malformed at the boundary.
      writeFileSync(
        join(dir, rolloutFilename("2026-06-21T07-00-00", "01900000-0000-7000-8000-000000000001")),
        [
          line({
            timestamp: NOW,
            type: "session_meta",
            payload: { timestamp: NOW, cwd: "/tmp/proj", type: "session_meta" },
          }),
          line({
            timestamp: NOW,
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "this turn must never be ingested" }],
            },
          }),
        ].join("\n"),
      );

      const result = await codexAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { codex: rejectRoot },
      });

      // Zero rows written for the rejected file.
      expect(result.sessions).toHaveLength(0);
      // A named diagnostic identifies the boundary breach.
      const rejection = result.diagnostics.find((diagnostic) =>
        diagnostic.message.includes("codex.session_meta.payload.id.missing"),
      )!;
      expect(rejection).toBeDefined();
      expect(rejection.status).toBe("error");
    } finally {
      rmSync(rejectRoot, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // QSR-220 — first-class subagents.
  //
  // Codex subagents are separate rollout-*.jsonl files, each with its own
  // UUIDv7. A subagent rollout records its spawning parent at
  // session_meta.payload.source.subagent.thread_spawn.parent_thread_id and its
  // identity at agent_nickname (fallback agent_role). The adapter emits a
  // canonical `subagent_of` edge whose fromId is the parent's canonical
  // SessionId; mapSession projects it onto SessionRow.parentSessionId.
  //
  // Real-shape fixture: a parent rollout + a subagent rollout whose
  // parent_thread_id points at the parent. All ids are fabricated.
  // ---------------------------------------------------------------------------
  test("subagent rollout maps parentSessionId to the parent canonical SessionId and sets agentName", async () => {
    const lineageRoot = mkdtempSync(join(tmpdir(), "quasar-codex-subagent-"));
    try {
      const dir = join(lineageRoot, "sessions", "2026", "06", "21");
      mkdirSync(dir, { recursive: true });
      const PARENT_UUID = "01900000-0000-7000-8000-0000000000a1";
      const CHILD_UUID = "01900000-0000-7000-8000-0000000000a2";

      // Parent rollout: a plain main session, no source.subagent.
      writeFileSync(
        join(dir, rolloutFilename("2026-06-21T07-00-00", PARENT_UUID)),
        [
          line({
            timestamp: NOW,
            type: "session_meta",
            payload: {
              id: PARENT_UUID,
              timestamp: NOW,
              cwd: "/tmp/proj",
              originator: "codex-tui",
              cli_version: "0.140.0",
              type: "session_meta",
            },
          }),
          line({
            timestamp: NOW,
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "spawn a subagent please" }],
            },
          }),
        ].join("\n"),
      );

      // Subagent rollout: source.subagent.thread_spawn.parent_thread_id points
      // at the parent's native id; agent_nickname carries the human label.
      writeFileSync(
        join(dir, rolloutFilename("2026-06-21T07-05-00", CHILD_UUID)),
        [
          line({
            timestamp: NOW,
            type: "session_meta",
            payload: {
              id: CHILD_UUID,
              timestamp: NOW,
              cwd: "/tmp/proj",
              originator: "codex-tui",
              cli_version: "0.140.0",
              type: "session_meta",
              source: {
                subagent: {
                  agent_nickname: "researcher",
                  agent_role: "research",
                  thread_spawn: { parent_thread_id: PARENT_UUID },
                },
              },
            },
          }),
          line({
            timestamp: NOW,
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "subagent doing the research" }],
            },
          }),
        ].join("\n"),
      );

      const result = await codexAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { codex: lineageRoot },
      });
      expect(result.sessions).toHaveLength(2);

      const parent = result.sessions.find((session) =>
        session.nativeSessionId === PARENT_UUID,
      )!;
      const child = result.sessions.find((session) =>
        session.nativeSessionId === CHILD_UUID,
      )!;
      expect(parent).toBeDefined();
      expect(child).toBeDefined();

      // The canonical edge is subagent_of (never "parent"), fromId = the parent
      // canonical SessionId = the parent session's own id, toId = the child.
      const edge = child.sessionEdges.find((candidate) => candidate.kind === "subagent_of")!;
      expect(edge).toBeDefined();
      expect(edge.fromId).toBe(parent.id);
      expect(edge.toId).toBe(child.id);

      // mapSession projects the edge onto SessionRow.parentSessionId.
      const mappedChild = mapSession(child, "fp-child");
      const mappedParent = mapSession(parent, "fp-parent");
      expect(mappedChild.session.parentSessionId).toBe(parent.id);
      expect(mappedChild.session.agentName).toBe("researcher");

      // A main session carries no parentSessionId and the default agentName.
      expect(mappedParent.session.parentSessionId).toBeUndefined();
      expect(mappedParent.session.agentName).toBe("codex");
    } finally {
      rmSync(lineageRoot, { recursive: true, force: true });
    }
  });

  test("agentName falls back to agent_role when no nickname is recorded", async () => {
    const roleRoot = mkdtempSync(join(tmpdir(), "quasar-codex-role-"));
    try {
      const dir = join(roleRoot, "sessions", "2026", "06", "21");
      mkdirSync(dir, { recursive: true });
      const PARENT_UUID = "01900000-0000-7000-8000-0000000000b1";
      const CHILD_UUID = "01900000-0000-7000-8000-0000000000b2";
      writeFileSync(
        join(dir, rolloutFilename("2026-06-21T08-05-00", CHILD_UUID)),
        [
          line({
            timestamp: NOW,
            type: "session_meta",
            payload: {
              id: CHILD_UUID,
              timestamp: NOW,
              cwd: "/tmp/proj",
              type: "session_meta",
              source: {
                subagent: {
                  agent_role: "reviewer",
                  thread_spawn: { parent_thread_id: PARENT_UUID },
                },
              },
            },
          }),
          line({
            timestamp: NOW,
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "reviewing" }],
            },
          }),
        ].join("\n"),
      );

      const result = await codexAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { codex: roleRoot },
      });
      const child = result.sessions.find((session) =>
        session.nativeSessionId === CHILD_UUID,
      )!;
      expect(mapSession(child, "fp").session.agentName).toBe("reviewer");
      const parentSessionId = sessionIdFor("codex", CodexSessionId(PARENT_UUID));
      expect(child.sessionEdges.find((edge) => edge.kind === "subagent_of")!.fromId).toBe(
        parentSessionId,
      );
    } finally {
      rmSync(roleRoot, { recursive: true, force: true });
    }
  });

  test("a malformed session_meta emits codex.session_meta.decode_failed and is dropped", async () => {
    const badRoot = mkdtempSync(join(tmpdir(), "quasar-codex-decode-"));
    try {
      const dir = join(badRoot, "sessions", "2026", "06", "21");
      mkdirSync(dir, { recursive: true });
      // payload.id is present (so it passes the native-id boundary gate) but the
      // record-level `type` literal is corrupted to a non-string, so the Effect
      // Schema rejects it: a named decode_failed diagnostic + a dropped decode.
      writeFileSync(
        join(dir, rolloutFilename("2026-06-21T09-00-00", "01900000-0000-7000-8000-0000000000c1")),
        [
          // Two records both look like session_meta to the cheap native-id probe
          // (record.type === "session_meta", payload.id present), but the second
          // field shape here corrupts payload.source into a non-object so the
          // strict subagent branch rejects the decode.
          JSON.stringify({
            timestamp: NOW,
            type: "session_meta",
            payload: {
              id: "01900000-0000-7000-8000-0000000000c1",
              cwd: "/tmp/proj",
              type: "session_meta",
              source: "this should be an object, not a string",
            },
          }),
          line({
            timestamp: NOW,
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "still has turn content" }],
            },
          }),
        ].join("\n"),
      );

      const result = await codexAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { codex: badRoot },
      });
      const diagnostic = result.diagnostics.find((candidate) =>
        candidate.message.includes("codex.session_meta.decode_failed"),
      )!;
      expect(diagnostic).toBeDefined();
      expect(diagnostic.status).toBe("unsupported");
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
    }
  });
});
