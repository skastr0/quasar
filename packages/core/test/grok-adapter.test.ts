import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

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

describe("grok adapter", () => {
  test("missing optional sidecars do not abort and later sidecar creation invalidates the fingerprint", async () => {
    const root = join(testRoot, "optional-sidecars");
    const sessionDir = join(root, "sessions", encodeURIComponent("/repo"), "session-1");
    mkdirSync(sessionDir, { recursive: true });
    writeJsonLines(join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "please inspect this terminal run" },
      { type: "assistant", content: "Done Reading the terminal output." },
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
