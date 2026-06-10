import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildSession,
  eventIdFor,
  sourceRoot,
} from "../src/adapters/common";
import { recordStreamFor } from "../src/adapters/record-stream";
import type {
  RecordStreamItem,
  SessionAdapter,
  SourceUnit,
  UnitFingerprint,
} from "../src/adapters/types";

const machine = {
  machineId: "machine:test",
  hostname: "test-host",
};
const now = "2026-06-10T00:00:00.000Z";

let tempRoots: string[] = [];

const collect = async <A>(stream: AsyncIterable<A>): Promise<A[]> => {
  const items: A[] = [];
  for await (const item of stream) items.push(item);
  return items;
};

const recordItems = (items: readonly RecordStreamItem[]) =>
  items.flatMap((item) => (item.type === "record" ? [item] : []));

const itemTypes = (items: readonly RecordStreamItem[]) =>
  items.map((item) => item.type);

const makeTempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-record-stream-"));
  tempRoots.push(root);
  return root;
};

const makeSession = () => {
  const sourcePath = "/logical/codex/rollout-test.jsonl";
  return buildSession({
    provider: "codex",
    agentName: "codex",
    machine,
    nativeSessionId: "rollout-test",
    sourceRoot: "/logical/codex",
    sourcePath,
    projectPath: "/work/quasar",
    events: [
      {
        id: eventIdFor("codex", machine.machineId, sourcePath, 0, "user"),
        sequence: 0,
        timestamp: now,
        role: "user",
        kind: "message",
        contentText: "hello",
        rawReference: { sourcePath, line: 1 },
      },
    ],
  });
};

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("adapter record streams", () => {
  test("bridges session streams into canonical records", async () => {
    const session = makeSession();
    const adapter: SessionAdapter = {
      id: "test-adapter",
      provider: "codex",
      displayName: "Test adapter",
      stable: true,
      defaultRoot: () => undefined,
      read: async () => ({ sourceRoots: [], sessions: [], diagnostics: [] }),
      stream: async function* () {
        yield {
          type: "sourceRoot" as const,
          sourceRoot: sourceRoot("codex", "test-adapter", "/logical/codex", machine, now),
        };
        yield { type: "session" as const, session };
      },
    };
    const units: { unit: SourceUnit; fingerprint: UnitFingerprint }[] = [];

    const items = await collect(
      recordStreamFor(adapter)({
        machine,
        now,
        shouldProcessUnit: (unit, fingerprint) => {
          units.push({ unit, fingerprint });
          return true;
        },
      }),
    );

    expect(itemTypes(items)).toEqual([
      "record",
      "unitStart",
      "record",
      "record",
      "record",
      "unitEnd",
      "rootScanned",
    ]);
    expect(recordItems(items).map((item) => item.item.type)).toEqual([
      "source_root",
      "session",
      "event",
      "content_block",
    ]);
    expect(units).toEqual([
      {
        unit: expect.objectContaining({
          provider: "codex",
          adapterId: "test-adapter",
          rootPath: "/logical/codex",
          sourcePath: "/logical/codex/rollout-test.jsonl",
        }),
        fingerprint: {},
      },
    ]);
  });

  test("bridge skips records for unchanged source units", async () => {
    const session = makeSession();
    const adapter: SessionAdapter = {
      id: "test-adapter",
      provider: "codex",
      displayName: "Test adapter",
      stable: true,
      defaultRoot: () => undefined,
      read: async () => ({ sourceRoots: [], sessions: [], diagnostics: [] }),
      stream: async function* () {
        yield {
          type: "sourceRoot" as const,
          sourceRoot: sourceRoot("codex", "test-adapter", "/logical/codex", machine, now),
        };
        yield { type: "session" as const, session };
      },
    };

    const items = await collect(
      recordStreamFor(adapter)({
        machine,
        now,
        shouldProcessUnit: () => false,
      }),
    );

    expect(itemTypes(items)).toEqual(["record", "unitStart", "unitEnd", "rootScanned"]);
    expect(recordItems(items).map((item) => item.item.type)).toEqual(["source_root"]);
  });

  test("Codex native streamRecords stats and skips unchanged files before opening", async () => {
    const root = makeTempRoot();
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(
      join(sessionsRoot, "rollout-skipped.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { cwd: "/work/quasar" } }),
    );
    const createReadStream = vi.fn(() => undefined as never);
    vi.doMock("node:fs", async () => ({
      ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
      createReadStream,
    }));
    const { codexAdapter } = await import("../src/adapters/codex");
    const units: { unit: SourceUnit; fingerprint: UnitFingerprint }[] = [];

    const items = await collect(
      codexAdapter.streamRecords!({
        machine,
        now,
        roots: { codex: root },
        shouldProcessUnit: (unit, fingerprint) => {
          units.push({ unit, fingerprint });
          return false;
        },
      }),
    );

    expect(createReadStream).not.toHaveBeenCalled();
    expect(itemTypes(items)).toContain("unitStart");
    expect(itemTypes(items)).toContain("unitEnd");
    expect(itemTypes(items)).toContain("rootScanned");
    expect(recordItems(items).map((item) => item.item.type)).toEqual(["source_root"]);
    expect(units).toEqual([
      {
        unit: expect.objectContaining({
          provider: "codex",
          adapterId: "codex-local-jsonl",
          sourcePath: join(root, "sessions", "rollout-skipped.jsonl"),
          physicalPath: join(root, "sessions", "rollout-skipped.jsonl"),
        }),
        fingerprint: {
          size: expect.any(Number),
          mtimeMs: expect.any(Number),
        },
      },
    ]);
  });

  test("Codex native streamRecords emits pruned and redacted records", async () => {
    const root = makeTempRoot();
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    const secret = `sk-${"a".repeat(24)}`;
    writeFileSync(
      join(sessionsRoot, "rollout-redacted.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/work/quasar" },
        }),
        JSON.stringify({
          timestamp: now,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: `Authorization: Bearer ${secret}`,
            diff: "patch-secret",
            encrypted_content: "cipher-secret",
          },
        }),
      ].join("\n"),
    );
    const { codexAdapter } = await import("../src/adapters/codex");

    const items = await collect(
      codexAdapter.streamRecords!({
        machine,
        now,
        roots: { codex: root },
      }),
    );
    const records = recordItems(items).map((item) => item.item);
    const serialized = JSON.stringify(records);

    expect(records.map((record) => record.type)).toContain("session");
    expect(records.map((record) => record.type)).toContain("event");
    expect(records.map((record) => record.type)).toContain("content_block");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("patch-secret");
    expect(serialized).not.toContain("cipher-secret");
    expect(serialized).not.toContain("encrypted_content");
  });
});
