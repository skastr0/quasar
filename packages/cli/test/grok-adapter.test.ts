import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { grokAdapter } from "../src/adapters/grok";

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
