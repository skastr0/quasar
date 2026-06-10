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
import type { NormalizedSession } from "../src/schemas";

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

const idsFor = (items: readonly RecordStreamItem[]) =>
  recordItems(items).flatMap((item) => {
    const record = item.item.record as { readonly id?: string };
    return typeof record.id === "string" ? [record.id] : [];
  });

const forbiddenKeysIn = (value: unknown): string[] => {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(forbiddenKeysIn);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const nested = forbiddenKeysIn(item);
    return /(?:^|_)(diff|patch|snapshot|ciphertext)(?:$|_)/i.test(key) ||
      /encrypted[_-]?content/i.test(key)
      ? [key, ...nested]
      : nested;
  });
};

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
      "unitEnd",
      "rootScanned",
    ]);
    expect(recordItems(items).map((item) => item.item.type)).toEqual([
      "source_root",
      "session",
      "event",
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
    const session = {
      provider: "codex",
      sourceRoot: "/logical/codex",
      sourcePath: "/logical/codex/rollout-test.jsonl",
    } as NormalizedSession;
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
        yield {
          type: "session" as const,
          session,
          sourceUnit: {
            provider: "codex",
            adapterId: "test-adapter",
            rootPath: "/logical/codex",
            sourcePath: "/logical/codex/rollout-test.jsonl",
            physicalPath: "/physical/codex/rollout-test.jsonl",
          },
        };
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
    expect(
      items.find((item): item is Extract<RecordStreamItem, { readonly type: "unitStart" }> =>
        item.type === "unitStart",
      )?.unit.physicalPath,
    ).toBe("/physical/codex/rollout-test.jsonl");
  });

  test("bridge fails closed when an adapter has no session stream", async () => {
    const read = vi.fn(async () => ({ sourceRoots: [], sessions: [makeSession()], diagnostics: [] }));
    const adapter: SessionAdapter = {
      id: "test-adapter",
      provider: "codex",
      displayName: "Test adapter",
      stable: true,
      defaultRoot: () => undefined,
      read,
    };

    const items = await collect(
      recordStreamFor(adapter)({
        machine,
        now,
      }),
    );

    expect(read).not.toHaveBeenCalled();
    expect(items).toEqual([
      {
        type: "diagnostic",
        diagnostic: {
          adapterId: "test-adapter",
          provider: "codex",
          status: "unsupported",
          message: "Adapter must expose a session stream before records can be streamed.",
        },
      },
    ]);
  });

  test("bridge marks root incomplete when source-unit predicate fails", async () => {
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
        shouldProcessUnit: () => {
          throw new Error("ledger unavailable");
        },
      }),
    );
    const unitEnd = items.find(
      (item): item is Extract<RecordStreamItem, { readonly type: "unitEnd" }> =>
        item.type === "unitEnd",
    );
    const rootScanned = items.find(
      (item): item is Extract<RecordStreamItem, { readonly type: "rootScanned" }> =>
        item.type === "rootScanned",
    );

    expect(unitEnd?.complete).toBe(false);
    expect(rootScanned?.complete).toBe(false);
    expect(items.some((item) => item.type === "diagnostic" && item.diagnostic.status === "error")).toBe(true);
  });

  test("Codex native streamRecords stats and skips unchanged files before opening", async () => {
    const root = makeTempRoot();
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    const skippedPath = join(sessionsRoot, "rollout-skipped.jsonl");
    writeFileSync(
      skippedPath,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/work/quasar" } }),
    );
    const createReadStream = vi.fn(() => undefined as never);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const statSync = vi.fn(actualFs.statSync);
    vi.doMock("node:fs", async () => ({
      ...actualFs,
      createReadStream,
      statSync,
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
    expect(statSync.mock.calls.filter(([path]) => path === skippedPath)).toHaveLength(1);
    expect(itemTypes(items)).toContain("unitStart");
    expect(itemTypes(items)).toContain("unitEnd");
    expect(itemTypes(items)).toContain("rootScanned");
    expect(recordItems(items).map((item) => item.item.type)).toEqual(["source_root"]);
    expect(units).toEqual([
      {
        unit: expect.objectContaining({
          provider: "codex",
          adapterId: "codex-local-jsonl",
          sourcePath: skippedPath,
          physicalPath: skippedPath,
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
    expect(records.map((record) => record.type)).not.toContain("content_block");
    expect(idsFor(items)).toEqual(idsFor(await collect(
      codexAdapter.streamRecords!({
        machine,
        now,
        roots: { codex: root },
      }),
    )));
    expect(forbiddenKeysIn(records)).toEqual([]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("patch-secret");
    expect(serialized).not.toContain("cipher-secret");
    expect(serialized).not.toContain("encrypted_content");
  });

  test("Codex native streamRecords marks malformed JSON source units incomplete", async () => {
    const root = makeTempRoot();
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(
      join(sessionsRoot, "rollout-broken.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/work/quasar" } }),
        "{not-json",
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
    const unitEnd = items.find(
      (item): item is Extract<RecordStreamItem, { readonly type: "unitEnd" }> =>
        item.type === "unitEnd",
    );
    const rootScanned = items.find(
      (item): item is Extract<RecordStreamItem, { readonly type: "rootScanned" }> =>
        item.type === "rootScanned",
    );

    expect(unitEnd?.complete).toBe(false);
    expect(rootScanned?.complete).toBe(false);
    expect(
      items.some(
        (item) =>
          item.type === "diagnostic" &&
          item.diagnostic.status === "error" &&
          item.diagnostic.message.includes("could not be streamed completely"),
      ),
    ).toBe(true);
  });
});
