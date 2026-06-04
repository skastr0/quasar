import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { buildIngestBatch } from "../src/ingest";

const machine = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "test",
};

describe("adapter ingestion", () => {
  test("reads a Codex rollout fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-codex-"));
    const sessionDir = join(root, "sessions", "2026", "06", "03");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "rollout-2026-06-03T00-00-00-test.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-03T00:00:00.000Z",
          payload: { cwd: "/Users/a/Projects/quasar" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-03T00:00:01.000Z",
          payload: { role: "assistant", content: "hello quasar" },
        }),
      ].join("\n"),
    );
    const batch = await buildIngestBatch({
      providers: ["codex"],
      roots: { codex: root },
      machine,
    });
    expect(batch.sessions).toHaveLength(1);
    expect(batch.sessions[0]?.events).toHaveLength(2);
  });
});
