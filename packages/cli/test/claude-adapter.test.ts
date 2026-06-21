import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { claudeAdapter } from "../src/adapters/claude";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-21T00:00:00.000Z";

// Root for all tests — cleaned up once at the end.
const testRoot = mkdtempSync(join(tmpdir(), "quasar-claude-adapter-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const line = (value: unknown) => JSON.stringify(value);

/**
 * Minimal main-session records carrying an in-record `sessionId`.
 * The native id is read from this field, NOT from the file path, so the same
 * records placed at any two paths yield the same canonical session.id.
 */
const mainSessionRecords = (sessionId: string) =>
  [
    line({ sessionId, type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
    line({ sessionId, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello back" }] } }),
  ].join("\n");

/**
 * Minimal subagent records carrying an in-record `agentId`.
 * Subagent files are named `agent-<uuid>.jsonl` and live under a `subagents/`
 * directory. Their native id is the in-record `agentId`, not the parent
 * sessionId and not the file's path components.
 */
const subagentRecords = (agentId: string) =>
  [
    line({ agentId, type: "user", message: { role: "user", content: [{ type: "text", text: "sub task" }] } }),
    line({ agentId, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "sub result" }] } }),
  ].join("\n");

// ---------------------------------------------------------------------------
// T1: basic session discovery
// ---------------------------------------------------------------------------
describe("T1: discovers sessions under projects/", () => {
  const root = join(testRoot, "t1");
  const projectDir = join(root, "projects", "-Users-me-myapp");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "aaaa1111-0001-0001-0001-000000000001.jsonl"), mainSessionRecords("aaaa1111-0001-0001-0001-000000000001"));

  test("discovers 1 session", async () => {
    const result = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: root },
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.provider).toBe("claude");
  });

  test("journal.jsonl is excluded", async () => {
    writeFileSync(join(projectDir, "journal.jsonl"), line({ started: NOW, type: "started" }));
    const result = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: root },
    });
    // Still 1, not 2.
    expect(result.sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC#5 — idempotency proof: main session (content-id, `sessionId` field)
//
// The native id is the in-record `sessionId` field. Place the SAME records
// at TWO DIFFERENT source paths (simulating a host vs Docker /history mount).
// Both adapter reads must produce byte-identical session.id values. The
// sourcePaths must differ — that is the whole point.
// ---------------------------------------------------------------------------
describe("AC#5 idempotency: main session — same in-record sessionId at different paths", () => {
  // Two independent roots simulating different machines/mounts.
  const hostRoot = mkdtempSync(join(tmpdir(), "quasar-claude-host-"));
  const dockerRoot = mkdtempSync(join(tmpdir(), "quasar-claude-docker-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(dockerRoot, { recursive: true, force: true });
  });

  const NATIVE_SESSION_ID = "bbbb2222-0002-0002-0002-000000000002";
  const FILENAME = `${NATIVE_SESSION_ID}.jsonl`;
  const CONTENT = mainSessionRecords(NATIVE_SESSION_ID);

  // Place the same file content at two different project paths.
  // Project key and parent directory differ between roots.
  const hostProjectDir = join(hostRoot, "projects", "-Users-alice-work");
  const dockerProjectDir = join(dockerRoot, "projects", "-history-alice-work");
  mkdirSync(hostProjectDir, { recursive: true });
  mkdirSync(dockerProjectDir, { recursive: true });
  writeFileSync(join(hostProjectDir, FILENAME), CONTENT);
  writeFileSync(join(dockerProjectDir, FILENAME), CONTENT);

  test("host and docker reads produce byte-identical session.id", async () => {
    const hostResult = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: hostRoot },
    });
    const dockerResult = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: dockerRoot },
    });

    expect(hostResult.sessions).toHaveLength(1);
    expect(dockerResult.sessions).toHaveLength(1);
    // The canonical session.id must be byte-identical regardless of path.
    expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
    // The sourcePaths must differ — proving the id is path-independent.
    expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
  });
});

// ---------------------------------------------------------------------------
// AC#5 idempotency: subagent file (content-id, `agentId` field)
//
// Subagent files use the in-record `agentId` as native id.  Same content at
// two different subagents/ paths → same canonical session.id.
// ---------------------------------------------------------------------------
describe("AC#5 idempotency: subagent — same in-record agentId at different paths", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "quasar-claude-sub-host-"));
  const dockerRoot = mkdtempSync(join(tmpdir(), "quasar-claude-sub-docker-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(dockerRoot, { recursive: true, force: true });
  });

  const AGENT_ID = "cccc3333-0003-0003-0003-000000000003";
  const FILENAME = `agent-${AGENT_ID}.jsonl`;
  const CONTENT = subagentRecords(AGENT_ID);

  // Two different parent session directories but the same agent file content.
  const hostSubDir = join(hostRoot, "projects", "-Users-alice-work", "subagents");
  const dockerSubDir = join(dockerRoot, "projects", "-history-alice-work", "subagents");
  mkdirSync(hostSubDir, { recursive: true });
  mkdirSync(dockerSubDir, { recursive: true });
  writeFileSync(join(hostSubDir, FILENAME), CONTENT);
  writeFileSync(join(dockerSubDir, FILENAME), CONTENT);

  test("host and docker reads produce byte-identical session.id for subagent", async () => {
    const hostResult = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: hostRoot },
    });
    const dockerResult = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: dockerRoot },
    });

    expect(hostResult.sessions).toHaveLength(1);
    expect(dockerResult.sessions).toHaveLength(1);
    expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
    expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
  });
});
