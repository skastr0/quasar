import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { grokAdapter } from "../src/adapters/grok";
import { GrokSessionId } from "../src/core/identity";
import { sessionIdFor } from "../src/adapters/common";
import { mapSession } from "../src/map";
import { GrokSubagentManifest } from "../src/adapters/grok-schema";
import { Schema } from "effect";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-01T00:00:00.000Z";

const testRoot = mkdtempSync(join(tmpdir(), "quasar-grok-test-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const writeJsonLines = (path: string, records: unknown[]) =>
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

// ---------------------------------------------------------------------------
// AC#5 — idempotency proof (dirname-id provider)
//
// Grok native id = basename of the session directory (a uuid-like string).
// Two different PARENT paths pointing to the SAME session directory name must
// yield byte-identical canonical session.id values.  The test writes the same
// session uuid dir under two different host/docker roots and asserts equality.
// ---------------------------------------------------------------------------
describe("AC#5 idempotency: same session dir name at different parent paths → byte-identical session.id", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "quasar-grok-host-"));
  const dockerRoot = mkdtempSync(join(tmpdir(), "quasar-grok-docker-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(dockerRoot, { recursive: true, force: true });
  });

  // Real on-disk shape: the grok session directory is named with a UUIDv7 and
  // that name is the native id. Only the parent path differs between the trees.
  const SESSION_UUID = "01900000-0000-7000-8000-000000000002";
  const PROJECT_KEY = encodeURIComponent("/repo/myapp");

  const writeSession = (root: string) => {
    const sessionDir = join(root, "sessions", PROJECT_KEY, SESSION_UUID);
    mkdirSync(sessionDir, { recursive: true });
    writeJsonLines(join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "hello from idempotency test" },
      { type: "assistant", content: "hello back" },
    ]);
    // Real sidecar shape: events.jsonl carries a turn_started record whose
    // session_id equals the directory name (the native id).
    writeJsonLines(join(sessionDir, "events.jsonl"), [
      {
        ts: NOW,
        type: "turn_started",
        session_id: SESSION_UUID,
        turn_number: 0,
        model_id: "grok-build",
        schema_version: "1.0",
      },
    ]);
  };

  writeSession(hostRoot);
  writeSession(dockerRoot);

  test("host and docker reads produce byte-identical session.id", async () => {
    const hostResult = await grokAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { grok: hostRoot },
    });
    const dockerResult = await grokAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { grok: dockerRoot },
    });

    expect(hostResult.sessions).toHaveLength(1);
    expect(dockerResult.sessions).toHaveLength(1);
    // The canonical id must be byte-identical despite different parent paths.
    expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
    // The sourcePaths must differ — proving the id does not encode the parent.
    expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
  });
});

describe("grok adapter", () => {
  test("missing optional sidecars do not abort and later sidecar creation invalidates the fingerprint", async () => {
    const root = join(testRoot, "optional-sidecars");
    // Real on-disk shape: the session directory is a UUIDv7, not "session-1".
    const sessionUuid = "01900000-0000-7000-8000-000000000007";
    const sessionDir = join(root, "sessions", encodeURIComponent("/repo"), sessionUuid);
    mkdirSync(sessionDir, { recursive: true });
    writeJsonLines(join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "please inspect this terminal run" },
      { type: "assistant", content: "Done Reading the terminal output." },
    ]);
    // events.jsonl turn_started carries session_id equal to the dir name.
    writeJsonLines(join(sessionDir, "events.jsonl"), [
      { ts: NOW, type: "turn_started", session_id: sessionUuid, turn_number: 0, schema_version: "1.0" },
    ]);

    const firstProbes: string[] = [];
    const first = await grokAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { grok: root },
      shouldParseSession: (probe) => {
        firstProbes.push(probe.sourceFingerprint);
        return true;
      },
    });
    expect(first.sessions).toHaveLength(1);
    expect(first.diagnostics[0]?.status).toBe("available");

    writeJsonLines(join(sessionDir, "updates.jsonl"), [
      { method: "tool.update", content: "sidecar appeared after first ingest" },
    ]);

    const secondProbes: string[] = [];
    const second = await grokAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { grok: root },
      shouldParseSession: (probe) => {
        secondProbes.push(probe.sourceFingerprint);
        return false;
      },
    });
    expect(second.sessions).toHaveLength(0);
    expect(secondProbes).toHaveLength(1);
    expect(secondProbes[0]).not.toBe(firstProbes[0]);
  });
});

// ---------------------------------------------------------------------------
// QSR-220 — first-class subagent lineage
//
// Grok writes a subagent CHILD as its OWN top-level session directory (own
// UUIDv7 + own chat_history.jsonl) and records the parent relationship ONLY in
// the parent's `<parent>/subagents/<child>/meta.json` manifest. The adapter must
// discover those manifests and, for each child session, emit a canonical
// `subagent_of` SessionEdge whose `fromId` is the PARENT's machine-independent
// Quasar SessionId, plus set the child's agentName from `subagent_type`.
// ---------------------------------------------------------------------------
describe("QSR-220 grok subagent lineage", () => {
  // Clearly-FABRICATED UUIDv7-shaped identifiers — never real on-disk ids.
  const PARENT_UUID = "01900000-0000-7000-8000-00000000aaaa";
  const CHILD_UUID = "01900000-0000-7000-8000-00000000bbbb";
  const SUBAGENT_TYPE = "explore";
  const PROJECT_KEY = encodeURIComponent("/repo/lineage");

  const setupRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-grok-lineage-"));
    const sessionsRoot = join(root, "sessions", PROJECT_KEY);
    // Parent session dir: own chat_history + a subagent manifest pointing at the child.
    const parentDir = join(sessionsRoot, PARENT_UUID);
    mkdirSync(parentDir, { recursive: true });
    writeJsonLines(join(parentDir, "chat_history.jsonl"), [
      { type: "user", content: "synthetic parent prompt" },
      { type: "assistant", content: "synthetic parent reply" },
    ]);
    const manifestDir = join(parentDir, "subagents", CHILD_UUID);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, "meta.json"),
      JSON.stringify({
        subagent_id: CHILD_UUID,
        parent_session_id: PARENT_UUID,
        child_session_id: CHILD_UUID,
        subagent_type: SUBAGENT_TYPE,
        description: "synthetic subagent",
        prompt: "synthetic fabricated prompt — not real content",
        status: "completed",
      }),
      "utf8",
    );
    // Child session dir: flat, top-level, own chat_history (ingested independently).
    const childDir = join(sessionsRoot, CHILD_UUID);
    mkdirSync(childDir, { recursive: true });
    writeJsonLines(join(childDir, "chat_history.jsonl"), [
      { type: "user", content: "synthetic child prompt" },
      { type: "assistant", content: "synthetic child reply" },
    ]);
    return root;
  };

  test("child session carries subagent_of edge → parent canonical SessionId, agentName = subagent_type", async () => {
    const root = setupRoot();
    try {
      const result = await grokAdapter.read({ machine: MACHINE, now: NOW, roots: { grok: root } });
      // Both the parent and child sessions are ingested flat.
      expect(result.sessions).toHaveLength(2);

      const parentSessionId = sessionIdFor("grok", GrokSessionId(PARENT_UUID));
      const childSessionId = sessionIdFor("grok", GrokSessionId(CHILD_UUID));

      const child = result.sessions.find((s) => s.id === childSessionId);
      const parent = result.sessions.find((s) => s.id === parentSessionId);
      expect(child).toBeDefined();
      expect(parent).toBeDefined();

      // The child carries the canonical subagent_of edge → parent SessionId.
      const edge = child!.sessionEdges.find((e) => e.kind === "subagent_of");
      expect(edge).toBeDefined();
      expect(edge!.fromId).toBe(parentSessionId);
      expect(edge!.toId).toBe(childSessionId);

      // agentName is sourced from the manifest subagent_type.
      expect(child!.agentName).toBe(SUBAGENT_TYPE);

      // End-to-end: map.ts projects subagent_of onto SessionRow.parentSessionId.
      const mappedChild = mapSession(child!, "fp-child");
      expect(mappedChild.session.parentSessionId).toBe(parentSessionId);

      // The parent is a top-level session: no subagent_of edge, default agentName.
      expect(parent!.sessionEdges.find((e) => e.kind === "subagent_of")).toBeUndefined();
      const mappedParent = mapSession(parent!, "fp-parent");
      expect(mappedParent.session.parentSessionId).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed subagent manifest is dropped fail-closed (no edge), ingest continues", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-grok-lineage-bad-"));
    try {
      const sessionsRoot = join(root, "sessions", PROJECT_KEY);
      const parentDir = join(sessionsRoot, PARENT_UUID);
      mkdirSync(parentDir, { recursive: true });
      writeJsonLines(join(parentDir, "chat_history.jsonl"), [
        { type: "user", content: "synthetic parent prompt" },
      ]);
      // Manifest missing required parent_session_id + subagent_type → garbage.
      const manifestDir = join(parentDir, "subagents", CHILD_UUID);
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(
        join(manifestDir, "meta.json"),
        JSON.stringify({ subagent_id: CHILD_UUID, child_session_id: CHILD_UUID }),
        "utf8",
      );
      const childDir = join(sessionsRoot, CHILD_UUID);
      mkdirSync(childDir, { recursive: true });
      writeJsonLines(join(childDir, "chat_history.jsonl"), [
        { type: "user", content: "synthetic child prompt" },
      ]);

      const result = await grokAdapter.read({ machine: MACHINE, now: NOW, roots: { grok: root } });
      // Both sessions still ingest; the bad manifest just yields no lineage edge.
      expect(result.sessions).toHaveLength(2);
      const childSessionId = sessionIdFor("grok", GrokSessionId(CHILD_UUID));
      const child = result.sessions.find((s) => s.id === childSessionId);
      expect(child).toBeDefined();
      expect(child!.sessionEdges.find((e) => e.kind === "subagent_of")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the subagent manifest schema rejects records missing required lineage fields", () => {
    const decode = Schema.decodeUnknownEither(GrokSubagentManifest);
    expect(decode({ parent_session_id: "p", child_session_id: "c", subagent_type: "explore" })._tag).toBe("Right");
    expect(decode({ child_session_id: "c", subagent_type: "explore" })._tag).toBe("Left");
    expect(decode({ parent_session_id: "", child_session_id: "c", subagent_type: "explore" })._tag).toBe("Left");
  });
});
