import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getFunctionName } from "convex/server";

import { api } from "../../../convex/_generated/api";
import { runProviderIngest, type IngestMutationClient } from "../src/commands/ingest";

const PROJECT_DIR = "-tmp-quasar-skip-project";

/**
 * A fake Convex client that counts mutations and emulates the server's
 * fingerprint idempotency: a session whose committed fingerprint already
 * matches is reported skipped (force overrides). It records mutation calls by
 * resolved function name so a test can prove ZERO per-session work on a warm
 * tick.
 */
class FakeConvex implements IngestMutationClient {
  readonly calls: string[] = [];
  /** sessionId -> last committed sourceFingerprint (the server's view). */
  readonly committed = new Map<string, string>();
  /** sessionId -> fingerprint claimed by an in-flight begin this run. */
  #pending = new Map<string, string>();

  countOf(name: string): number {
    return this.calls.filter((call) => call === name).length;
  }

  reset(): void {
    this.calls.length = 0;
  }

  mutation(reference: unknown, args: unknown): Promise<unknown> {
    const name = getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
    this.calls.push(name);
    const payload = args as Record<string, unknown>;
    if (name === "quasar:beginSessionIngest") {
      const sessionId = String(payload.sessionId);
      const fingerprint = String(payload.sourceFingerprint);
      const force = payload.force === true;
      const known = this.committed.get(sessionId);
      if (!force && known === fingerprint) return Promise.resolve({ skipped: true });
      this.#pending.set(sessionId, fingerprint);
      return Promise.resolve({ skipped: false });
    }
    if (name === "quasar:deleteSessionTurns") {
      // deleted < batchSize ends the engine's drain loop after one call.
      return Promise.resolve({ deleted: 0, batchSize: 250 });
    }
    if (name === "quasar:commitSessionIngest") {
      const sessionId = String(payload.sessionId);
      const fingerprint = this.#pending.get(sessionId);
      if (fingerprint !== undefined) this.committed.set(sessionId, fingerprint);
      return Promise.resolve({});
    }
    return Promise.resolve({});
  }
}

let root: string;
let ledgerHome: string;
let sessionFiles: string[];

const writeSession = (name: string, turns: number): string => {
  const path = join(root, "projects", PROJECT_DIR, `${name}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < turns; i += 1) {
    lines.push(
      JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        cwd: "/tmp/quasar-skip-project",
        uuid: `${name}-${i}`,
        timestamp: `2026-06-16T00:00:0${i}.000Z`,
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `turn ${i} of ${name}` }],
        },
      }),
    );
  }
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quasar-skip-root-"));
  ledgerHome = mkdtempSync(join(tmpdir(), "quasar-skip-home-"));
  mkdirSync(join(root, "projects", PROJECT_DIR), { recursive: true });
  sessionFiles = [
    writeSession("alpha", 2),
    writeSession("bravo", 2),
    writeSession("charlie", 2),
  ];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(ledgerHome, { recursive: true, force: true });
});

const run = (
  client: FakeConvex,
  extra: { readonly force?: boolean; readonly reset?: boolean } = {},
) =>
  runProviderIngest({
    provider: "claude",
    root,
    client,
    ledgerHome,
    ...extra,
  });

describe("ingest fingerprint ledger skips unchanged sessions before parse", () => {
  test("tick1 cold ingests every session; tick2 warm makes zero per-session calls", async () => {
    const client = new FakeConvex();
    const K = sessionFiles.length;

    const cold = await run(client);
    expect(cold.sessionsWritten).toBe(K);
    // A begin + commit per session on the cold tick.
    expect(client.countOf("quasar:beginSessionIngest")).toBe(K);
    expect(client.countOf("quasar:commitSessionIngest")).toBe(K);

    // Warm tick: the ledger now matches every session, so the adapter skips
    // each before parsing — zero sessions reach the server at all.
    client.reset();
    const warm = await run(client);
    expect(warm.sessionsWritten).toBe(0);
    expect(warm.sessionsSkipped).toBe(0);
    expect(client.countOf("quasar:beginSessionIngest")).toBe(0);
    expect(client.countOf("quasar:commitSessionIngest")).toBe(0);
    expect(client.countOf("quasar:deleteSessionTurns")).toBe(0);
    expect(client.countOf("quasar:insertMessages")).toBe(0);
  });

  test("--force re-parses and re-begins every session despite a warm ledger", async () => {
    const client = new FakeConvex();
    const K = sessionFiles.length;
    await run(client);

    client.reset();
    const forced = await run(client, { force: true });
    // force bypasses the local ledger gate: every session is parsed and begun.
    expect(client.countOf("quasar:beginSessionIngest")).toBe(K);
    // The server honors force too, so each is re-committed.
    expect(forced.sessionsWritten).toBe(K);
  });

  test("--reset clears the ledger and re-consults the server for every session", async () => {
    const client = new FakeConvex();
    const K = sessionFiles.length;
    await run(client);

    client.reset();
    const resetRun = await run(client, { reset: true });
    // reset bypasses + clears the local cache: every session reaches begin.
    expect(client.countOf("quasar:beginSessionIngest")).toBe(K);
    // The server's fingerprints are unchanged, so it skips each begin: zero
    // re-writes, but each was re-consulted (the dangerous wrong-skip cannot
    // happen because the server stays authoritative).
    expect(resetRun.sessionsWritten).toBe(0);
    expect(resetRun.sessionsSkipped).toBe(K);
  });

  test("a mutated session re-ingests exactly that one on the next tick", async () => {
    const client = new FakeConvex();
    await run(client);

    // Mutate exactly one fixture: its stat fingerprint changes, so its ledger
    // entry no longer matches and only it is re-parsed and begun.
    writeSession("bravo", 5);

    client.reset();
    const tick = await run(client);
    expect(client.countOf("quasar:beginSessionIngest")).toBe(1);
    expect(tick.sessionsWritten).toBe(1);
  });
});
