import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";
import { afterAll, describe, expect, test } from "bun:test";

import { codexAdapter } from "../src/adapters/codex";
import { sessionIdFor } from "../src/adapters/common";
import {
  CODEX_RECORD_REGISTRY,
  CODEX_UNKNOWN_RECORD_TYPE,
  classifyCodexRecord,
  codexDiscriminatorOf,
} from "../src/adapters/codex-schema";
import type { SignalDecision } from "../src/adapters/harness-schema";
import { CodexSessionId } from "../src/core/identity";
import type { SessionEventKind } from "../src/core/schemas";
import { mapSession } from "../src/map";

const MACHINE = {
  machineId: "machine:test",
  // Fabricated host — resolves to ZERO real on-disk data (privacy mandate).
  hostname: "qsr-fab-host",
  platform: "darwin",
};

const NOW = "2026-06-11T00:00:00.000Z";

const line = (value: unknown) => JSON.stringify(value);

// Real on-disk shape: every rollout file is named
// rollout-<ISO datetime>-<uuidv7>.jsonl and its line 1 is a session_meta
// record whose payload.id is that same UUIDv7 (the codex native session id).
//
// PRIVACY: every identifier below is FABRICATED in the `0fab0000-fab0-7fab-…` /
// `qsr-fab-…` / `/qsr/fab/…` namespace, each grepped to ZERO matches against the
// real provider root (~/.codex) before finalizing.
const FIXTURE_UUID = "0fab0000-fab0-7fab-8fab-000000000001";
const FIXTURE_CWD = "/qsr/fab/proj";
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
        originator: "qsr-fab-tui",
        cli_version: "0.0.0-qsr-fab",
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
        content: [{ type: "input_text", text: "qsr fabricated human turn" }],
      },
    }),
    // event_msg duplicate of the same turn.
    line({
      timestamp: NOW,
      type: "event_msg",
      payload: { type: "user_message", message: "qsr fabricated human turn" },
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
        call_id: "qsrfab_call_fn",
        name: "shell",
        arguments: '{"command":["ls"]}',
      },
    }),
    line({
      timestamp: NOW,
      type: "response_item",
      payload: { type: "function_call_output", call_id: "qsrfab_call_fn", output: "file.txt" },
    }),
    // custom_tool_call pair (apply_patch carries raw text in `input`).
    line({
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "qsrfab_call_patch",
        name: "apply_patch",
        status: "completed",
        input: "*** Begin Patch\n*** Update File: /qsr/fab/a.ts\n*** End Patch",
      },
    }),
    line({
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "qsrfab_call_patch",
        output: "Success. Updated the following files:\nM /qsr/fab/a.ts",
      },
    }),
    // Assistant reply.
    line({
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "qsr fabricated assistant reply" }],
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
    const liveUuid = "0fab0000-fab0-7fab-8fab-000000000001";
    const archivedUuid = "0fab0000-fab0-7fab-8fab-000000000002";
    writeFileSync(
      join(datedDir, rolloutFilename("2026-06-11T03-14-02", liveUuid)),
      rolloutLines(FIXTURE_CWD, liveUuid),
    );
    writeFileSync(
      join(archivedDir, rolloutFilename("2026-05-01T09-00-00", archivedUuid)),
      rolloutLines(FIXTURE_CWD, archivedUuid),
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
    expect(session.host).toBe("qsr-fab-host");
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
    const wrapperUuid = "0fab0000-fab0-7fab-8fab-000000000003";
    const wrapperFile = rolloutFilename("2026-06-12T10-00-00", wrapperUuid);
    writeFileSync(
      join(wrapperDir, wrapperFile),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { id: wrapperUuid, timestamp: NOW, cwd: FIXTURE_CWD, type: "session_meta" },
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
            content: [{ type: "input_text", text: "qsr fabricated real question from a human" }],
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
      "qsr fabricated real question from a human",
    );
    expect(
      session.events.filter((event) => event.kind === "preamble"),
    ).toHaveLength(wrapperTexts.length);
  });

  test("empty text stubs carry no turn content — no JSON envelope dump (measured 2026-06-11)", async () => {
    const stubDir = join(root, "sessions", "2026", "06", "14");
    mkdirSync(stubDir, { recursive: true });
    const stubUuid = "0fab0000-fab0-7fab-8fab-000000000004";
    const stubFile = rolloutFilename("2026-06-14T11-22-33", stubUuid);
    writeFileSync(
      join(stubDir, stubFile),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { id: stubUuid, timestamp: NOW, cwd: FIXTURE_CWD, type: "session_meta" },
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
            content: [{ type: "output_text", text: "qsr fabricated real reply" }],
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
      ["text", "qsr fabricated real reply"],
    ]);
  });

  test("merges local_shell_call pairs into completed tool calls (input from `action`)", async () => {
    const shellDir = join(root, "sessions", "2026", "06", "13");
    mkdirSync(shellDir, { recursive: true });
    const shellUuid = "0fab0000-fab0-7fab-8fab-000000000005";
    const shellFile = rolloutFilename("2026-06-13T08-15-00", shellUuid);
    writeFileSync(
      join(shellDir, shellFile),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { id: shellUuid, timestamp: NOW, cwd: FIXTURE_CWD, type: "session_meta" },
        }),
        line({
          timestamp: NOW,
          type: "response_item",
          payload: {
            type: "local_shell_call",
            call_id: "qsrfab_call_shell",
            status: "completed",
            action: { type: "exec", command: ["bash", "-lc", "ls"] },
          },
        }),
        line({
          timestamp: NOW,
          type: "response_item",
          payload: { type: "local_shell_call_output", call_id: "qsrfab_call_shell", output: "file.txt" },
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
      const SHARED_UUID = "0fab0000-fab0-7fab-8fab-000000000006";
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
      const content = rolloutLines("/qsr/fab/idem-proj", SHARED_UUID);
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
        join(dir, rolloutFilename("2026-06-21T07-00-00", "0fab0000-fab0-7fab-8fab-000000000001")),
        [
          line({
            timestamp: NOW,
            type: "session_meta",
            payload: { timestamp: NOW, cwd: FIXTURE_CWD, type: "session_meta" },
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
  // UUIDv7. A subagent rollout records its spawning parent AND its identity
  // under session_meta.payload.source.subagent.thread_spawn: the parent at
  // thread_spawn.parent_thread_id, the identity at thread_spawn.agent_nickname
  // (fallback thread_spawn.agent_role). Measured 2026-06-21 across all 517
  // subagent rollouts — the identity lives under thread_spawn, not at the
  // subagent level. The adapter emits a canonical `subagent_of` edge whose
  // fromId is the parent's canonical SessionId; mapSession projects it onto
  // SessionRow.parentSessionId.
  //
  // Real-shape fixture: a parent rollout + a subagent rollout whose
  // parent_thread_id points at the parent. All ids are fabricated.
  // ---------------------------------------------------------------------------
  test("subagent rollout maps parentSessionId to the parent canonical SessionId and sets agentName", async () => {
    const lineageRoot = mkdtempSync(join(tmpdir(), "quasar-codex-subagent-"));
    try {
      const dir = join(lineageRoot, "sessions", "2026", "06", "21");
      mkdirSync(dir, { recursive: true });
      const PARENT_UUID = "0fab0000-fab0-7fab-8fab-0000000000a1";
      const CHILD_UUID = "0fab0000-fab0-7fab-8fab-0000000000a2";

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
              cwd: FIXTURE_CWD,
              originator: "qsr-fab-tui",
              cli_version: "0.0.0-qsr-fab",
              type: "session_meta",
            },
          }),
          line({
            timestamp: NOW,
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "qsr fabricated spawn a subagent please" }],
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
              cwd: FIXTURE_CWD,
              originator: "qsr-fab-tui",
              cli_version: "0.0.0-qsr-fab",
              type: "session_meta",
              // Real on-disk shape (all 517 subagent rollouts): identity lives
              // under thread_spawn, NOT at the subagent level.
              source: {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: PARENT_UUID,
                    agent_nickname: "qsr-fab-agent-name",
                    agent_role: "qsr-fab-role",
                    agent_path: "/qsr/fab/agents/qsr-fab-agent.md",
                    depth: 1,
                  },
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
              content: [{ type: "output_text", text: "qsr fabricated subagent doing the work" }],
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
      expect(mappedChild.session.agentName).toBe("qsr-fab-agent-name");

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
      const PARENT_UUID = "0fab0000-fab0-7fab-8fab-0000000000b1";
      const CHILD_UUID = "0fab0000-fab0-7fab-8fab-0000000000b2";
      writeFileSync(
        join(dir, rolloutFilename("2026-06-21T08-05-00", CHILD_UUID)),
        [
          line({
            timestamp: NOW,
            type: "session_meta",
            payload: {
              id: CHILD_UUID,
              timestamp: NOW,
              cwd: FIXTURE_CWD,
              type: "session_meta",
              // Real on-disk shape: identity (here role-only) lives under
              // thread_spawn, exercising the agent_role fallback on the real path.
              source: {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: PARENT_UUID,
                    agent_role: "qsr-fab-role-only",
                  },
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
              content: [{ type: "output_text", text: "qsr fabricated reviewing" }],
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
      expect(mapSession(child, "fp").session.agentName).toBe("qsr-fab-role-only");
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
      // record `payload.source` is corrupted to a non-object, so the Effect
      // Schema rejects it: a named decode_failed diagnostic + a dropped decode.
      writeFileSync(
        join(dir, rolloutFilename("2026-06-21T09-00-00", "0fab0000-fab0-7fab-8fab-0000000000c1")),
        [
          // Two records both look like session_meta to the cheap native-id probe
          // (record.type === "session_meta", payload.id present), but the
          // field shape here corrupts payload.source into a non-object so the
          // strict subagent branch rejects the decode.
          JSON.stringify({
            timestamp: NOW,
            type: "session_meta",
            payload: {
              id: "0fab0000-fab0-7fab-8fab-0000000000c1",
              cwd: FIXTURE_CWD,
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
              content: [{ type: "input_text", text: "qsr fabricated still has turn content" }],
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

// ===========================================================================
// QSR-220 FULL DATA FIDELITY — per-record-type declarative signal/drop dispatch.
//
// Every distinct on-disk record type is modeled and routed through the
// fail-closed classifier. There is ZERO `unknown` pass-through: every record is
// EXPLICITLY signal(kind) or drop(reason). The fixtures here are built FROM the
// Effect schemas: each fixture is first decoded through its registry schema
// (`assertSchemaValid`) so a schema change that rejects the shape breaks the
// test at construction, then classified to assert its verdict.
// ===========================================================================

const isSignal = <A, K extends string>(
  decision: SignalDecision<A, K>,
): decision is { readonly _tag: "signal"; readonly kind: K; readonly value: A } =>
  decision._tag === "signal";

/**
 * Prove a fixture is schema-valid against its modeled registry schema, then
 * return it unchanged. This makes every fixture SCHEMA-DRIVEN: a tightening of
 * any field schema that the fixture violates throws here at construction time.
 */
const assertSchemaValid = (record: Record<string, unknown>) => {
  const discriminator = codexDiscriminatorOf(record)!;
  const entry = CODEX_RECORD_REGISTRY.get(discriminator)!;
  expect(entry).toBeDefined();
  const subject =
    discriminator.startsWith("response_item.") || discriminator.startsWith("event_msg.")
      ? (record as { payload?: unknown }).payload
      : record;
  // Throws if the fixture does not conform to the modeled schema.
  Schema.decodeUnknownSync(entry.schema)(subject);
  return record;
};

/** A minimal, schema-valid response_item envelope. */
const responseItem = (payload: Record<string, unknown>) =>
  assertSchemaValid({ timestamp: NOW, type: "response_item", payload });

/** A minimal, schema-valid event_msg envelope. */
const eventMsg = (payload: Record<string, unknown>) =>
  assertSchemaValid({ timestamp: NOW, type: "event_msg", payload });

describe("codex full data fidelity — declarative signal/drop per record type", () => {
  const SIGNAL_CASES: ReadonlyArray<{
    readonly name: string;
    readonly kind: SessionEventKind;
    readonly record: Record<string, unknown>;
  }> = [
    {
      name: "session_meta",
      kind: "system",
      record: assertSchemaValid({
        type: "session_meta",
        timestamp: NOW,
        payload: { id: "0fab0000-fab0-7fab-8fab-0000000000d1", cwd: FIXTURE_CWD, type: "session_meta" },
      }),
    },
    {
      name: "compacted",
      kind: "summary",
      record: assertSchemaValid({
        type: "compacted",
        timestamp: NOW,
        payload: { message: "qsr fabricated compaction summary", replacement_history: [] },
      }),
    },
    {
      name: "response_item.message",
      kind: "message",
      record: responseItem({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "qsr fabricated message" }],
      }),
    },
    {
      name: "response_item.function_call",
      kind: "tool_call",
      record: responseItem({ type: "function_call", call_id: "qsrfab_call_a", name: "shell", arguments: "{}" }),
    },
    {
      name: "response_item.function_call_output",
      kind: "tool_result",
      record: responseItem({ type: "function_call_output", call_id: "qsrfab_call_a", output: "ok" }),
    },
    {
      name: "response_item.custom_tool_call",
      kind: "tool_call",
      record: responseItem({ type: "custom_tool_call", call_id: "qsrfab_call_b", name: "apply_patch", input: "x" }),
    },
    {
      name: "response_item.custom_tool_call_output",
      kind: "tool_result",
      record: responseItem({ type: "custom_tool_call_output", call_id: "qsrfab_call_b", output: "done" }),
    },
    {
      name: "response_item.local_shell_call",
      kind: "tool_call",
      record: responseItem({
        type: "local_shell_call",
        call_id: "qsrfab_call_c",
        action: { type: "exec", command: ["ls"] },
      }),
    },
    {
      name: "response_item.local_shell_call_output",
      kind: "tool_result",
      record: responseItem({ type: "local_shell_call_output", call_id: "qsrfab_call_c", output: "file" }),
    },
    {
      name: "response_item.reasoning",
      kind: "reasoning",
      record: responseItem({ type: "reasoning", summary: [], encrypted_content: "gAAAAAB-x" }),
    },
    {
      name: "response_item.web_search_call",
      kind: "tool_call",
      record: responseItem({
        type: "web_search_call",
        call_id: "qsrfab_call_ws",
        status: "completed",
        action: { type: "search", query: "qsr fabricated query" },
      }),
    },
    {
      name: "response_item.tool_search_call",
      kind: "tool_call",
      record: responseItem({
        type: "tool_search_call",
        call_id: "qsrfab_call_ts",
        status: "completed",
        execution: "client",
        arguments: { query: "qsr fabricated tool query" },
      }),
    },
    {
      // FIX: tool_search_output is a tool RESULT (the returned tools), not a call.
      name: "response_item.tool_search_output",
      kind: "tool_result",
      record: responseItem({
        type: "tool_search_output",
        call_id: "qsrfab_call_ts",
        status: "completed",
        execution: "client",
        tools: [{ type: "namespace", name: "qsr_fab_tool_ns" }],
      }),
    },
    {
      name: "event_msg.token_count",
      kind: "usage",
      record: eventMsg({
        type: "token_count",
        info: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      }),
    },
    {
      name: "event_msg.agent_message",
      kind: "message",
      record: eventMsg({ type: "agent_message", message: "qsr fabricated agent message", phase: null }),
    },
    {
      name: "event_msg.user_message",
      kind: "message",
      record: eventMsg({ type: "user_message", message: "qsr fabricated user message" }),
    },
    {
      name: "event_msg.task_started",
      kind: "lifecycle",
      record: eventMsg({ type: "task_started", turn_id: "0fab0000-fab0-7fab-8fab-0000000000e1", started_at: 1 }),
    },
    {
      name: "event_msg.task_complete",
      kind: "lifecycle",
      record: eventMsg({ type: "task_complete", turn_id: "0fab0000-fab0-7fab-8fab-0000000000e1", duration_ms: 2 }),
    },
    {
      name: "event_msg.turn_aborted",
      kind: "lifecycle",
      record: eventMsg({ type: "turn_aborted", turn_id: "0fab0000-fab0-7fab-8fab-0000000000e1", reason: "interrupted" }),
    },
    {
      // FIX: mcp_tool_call_end carries the tool result, not unknown pass-through.
      name: "event_msg.mcp_tool_call_end",
      kind: "tool_result",
      record: eventMsg({
        type: "mcp_tool_call_end",
        call_id: "qsrfab_call_mcp",
        invocation: { server: "qsr_fab_server", tool: "qsr_fab_tool" },
        result: { Ok: { content: [] } },
      }),
    },
  ];

  const DROP_CASES: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
    readonly record: Record<string, unknown>;
  }> = [
    {
      name: "turn_context",
      reason: "codex.turn_context.provider_bookkeeping",
      record: assertSchemaValid({
        type: "turn_context",
        timestamp: NOW,
        payload: { turn_id: "0fab0000-fab0-7fab-8fab-0000000000f1", cwd: FIXTURE_CWD, model: "qsr-fab-model" },
      }),
    },
    {
      name: "event_msg.exec_command_end",
      reason: "codex.event_msg.exec_command_end.provider_bookkeeping",
      record: eventMsg({ type: "exec_command_end", call_id: "qsrfab_call_x", exit_code: 0, status: "completed" }),
    },
    {
      name: "event_msg.patch_apply_end",
      reason: "codex.event_msg.patch_apply_end.provider_bookkeeping",
      record: eventMsg({ type: "patch_apply_end", call_id: "qsrfab_call_y", success: true }),
    },
    {
      name: "event_msg.web_search_end",
      reason: "codex.event_msg.web_search_end.provider_bookkeeping",
      record: eventMsg({ type: "web_search_end", call_id: "qsrfab_call_ws", query: "qsr fabricated query" }),
    },
    {
      name: "event_msg.thread_goal_updated",
      reason: "codex.event_msg.thread_goal_updated.provider_bookkeeping",
      record: eventMsg({ type: "thread_goal_updated", threadId: "0fab0000-fab0-7fab-8fab-0000000000f2" }),
    },
    {
      name: "event_msg.context_compacted",
      reason: "codex.event_msg.context_compacted.provider_bookkeeping",
      record: eventMsg({ type: "context_compacted" }),
    },
    {
      name: "event_msg.item_completed",
      reason: "codex.event_msg.item_completed.provider_bookkeeping",
      record: eventMsg({ type: "item_completed", thread_id: "0fab0000-fab0-7fab-8fab-0000000000f3" }),
    },
    {
      name: "event_msg.thread_name_updated",
      reason: "codex.event_msg.thread_name_updated.provider_bookkeeping",
      record: eventMsg({ type: "thread_name_updated", thread_name: "qsr fabricated thread name" }),
    },
    {
      name: "event_msg.collab_agent_spawn_end",
      reason: "codex.event_msg.collab_agent_spawn_end.provider_bookkeeping",
      record: eventMsg({
        type: "collab_agent_spawn_end",
        call_id: "qsrfab_call_z",
        new_agent_nickname: "qsr-fab-agent-name",
        new_agent_role: "qsr-fab-role",
      }),
    },
    {
      name: "event_msg.collab_waiting_end",
      reason: "codex.event_msg.collab_waiting_end.provider_bookkeeping",
      record: eventMsg({ type: "collab_waiting_end", call_id: "qsrfab_call_z", agent_statuses: [] }),
    },
    {
      name: "event_msg.error",
      reason: "codex.event_msg.error.provider_bookkeeping",
      record: eventMsg({ type: "error", message: "qsr fabricated error", codex_error_info: "unauthorized" }),
    },
  ];

  for (const signalCase of SIGNAL_CASES) {
    test(`${signalCase.name} -> signal(${signalCase.kind})`, () => {
      const decision = classifyCodexRecord(signalCase.record);
      expect(isSignal(decision)).toBe(true);
      if (isSignal(decision)) expect(decision.kind).toBe(signalCase.kind);
    });
  }

  for (const dropCase of DROP_CASES) {
    test(`${dropCase.name} -> drop(${dropCase.reason})`, () => {
      const decision = classifyCodexRecord(dropCase.record);
      expect(decision._tag).toBe("drop");
      if (decision._tag === "drop") expect(decision.reason).toContain(dropCase.reason);
    });
  }

  test("every modeled record type is covered by an EXPLICIT signal/drop case — ZERO unknown pass-through", () => {
    // Every discriminator in the registry must be covered by a signal or drop
    // case above. A new on-disk type added to the registry without a verdict
    // assertion breaks this guard.
    const covered = new Set<string>([
      ...SIGNAL_CASES.map((c) => c.name),
      ...DROP_CASES.map((c) => c.name),
    ]);
    const registryKeys = new Set<string>(CODEX_RECORD_REGISTRY.keys());
    expect([...registryKeys].sort()).toEqual([...covered].sort());
    // No classification of a modeled record returns kind "unknown".
    for (const signalCase of SIGNAL_CASES) {
      const decision = classifyCodexRecord(signalCase.record);
      if (isSignal(decision)) expect(decision.kind).not.toBe("unknown");
    }
  });

  test("an unmodeled record type is an explicit named drop, never an unknown event", () => {
    const decision = classifyCodexRecord({ type: "qsr_fab_unmodeled_type", payload: {} });
    expect(decision._tag).toBe("drop");
    if (decision._tag === "drop") expect(decision.reason).toContain(CODEX_UNKNOWN_RECORD_TYPE);
  });

  test("a record with no resolvable discriminator is an explicit named drop", () => {
    const decision = classifyCodexRecord({ no_type_field: true });
    expect(decision._tag).toBe("drop");
    if (decision._tag === "drop") expect(decision.reason).toContain(CODEX_UNKNOWN_RECORD_TYPE);
  });

  // -------------------------------------------------------------------------
  // Malformed-record tests per major type: a record whose discriminator is
  // known but whose shape violates the schema becomes the NAMED
  // `codex.<type>.decode_failed` drop + an accumulated diagnostic — never a
  // throw, never a silent coercion.
  // -------------------------------------------------------------------------
  const MALFORMED_CASES: ReadonlyArray<{
    readonly name: string;
    readonly diagnostic: string;
    readonly record: Record<string, unknown>;
  }> = [
    {
      name: "response_item.message (content is a number)",
      diagnostic: "codex.response_item.message.decode_failed",
      record: { type: "response_item", payload: { type: "message", content: 42 } },
    },
    {
      name: "response_item.function_call (arguments is an object, not a string)",
      diagnostic: "codex.response_item.function_call.decode_failed",
      record: { type: "response_item", payload: { type: "function_call", arguments: { not: "a string" } } },
    },
    {
      name: "response_item.reasoning (encrypted_content is a number)",
      diagnostic: "codex.response_item.reasoning.decode_failed",
      record: { type: "response_item", payload: { type: "reasoning", encrypted_content: 7 } },
    },
    {
      name: "event_msg.token_count (info is a string)",
      diagnostic: "codex.event_msg.token_count.decode_failed",
      record: { type: "event_msg", payload: { type: "token_count", info: "not an object" } },
    },
    {
      name: "event_msg.user_message (message is a number)",
      diagnostic: "codex.event_msg.user_message.decode_failed",
      record: { type: "event_msg", payload: { type: "user_message", message: 99 } },
    },
    {
      name: "event_msg.mcp_tool_call_end (call_id is a number)",
      diagnostic: "codex.event_msg.mcp_tool_call_end.decode_failed",
      record: { type: "event_msg", payload: { type: "mcp_tool_call_end", call_id: 5 } },
    },
    {
      name: "session_meta (payload.id missing)",
      diagnostic: "codex.session_meta.decode_failed",
      record: { type: "session_meta", payload: { cwd: FIXTURE_CWD, type: "session_meta" } },
    },
    {
      name: "compacted (payload is a string)",
      diagnostic: "codex.compacted.decode_failed",
      record: { type: "compacted", payload: "not an object" },
    },
    {
      name: "turn_context (payload.cwd is a number)",
      diagnostic: "codex.turn_context.decode_failed",
      record: { type: "turn_context", payload: { cwd: 3 } },
    },
  ];

  for (const malformed of MALFORMED_CASES) {
    test(`malformed ${malformed.name} -> named ${malformed.diagnostic} + drop (no throw)`, () => {
      const diagnostics: Array<{ name: string; message: string }> = [];
      let decision: ReturnType<typeof classifyCodexRecord> | undefined;
      // The classifier must never throw on garbage — it returns a drop.
      expect(() => {
        decision = classifyCodexRecord(malformed.record, diagnostics);
      }).not.toThrow();
      expect(decision!._tag).toBe("drop");
      if (decision!._tag === "drop") expect(decision!.reason).toContain(malformed.diagnostic);
      // The named diagnostic was accumulated for boundary surfacing.
      expect(diagnostics.some((d) => d.name === malformed.diagnostic)).toBe(true);
    });
  }
});
