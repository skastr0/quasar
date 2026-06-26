import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer } from "../src/lancedb";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";

import type { MappedSession } from "../src/model";
import { DerivedSearch, DerivedSearchLive } from "../src/search";
import { LocalStore, makeLocalStoreLayer } from "../src/store";
import { diffPairs, verifyIndexed } from "../src/verify";

const tempDirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-verify-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const session = (sessionId: string, count: number): MappedSession => ({
  project: { projectKey: "p", displayName: "P", rawPath: "/tmp/p" },
  session: {
    sessionId,
    projectKey: "p",
    provider: "codex",
    agentName: "codex",
    sourcePath: `/h/${sessionId}.jsonl`,
    sourceFingerprint: `fp-${count}`,
    host: "h",
    identitySchemeVersion: 1,
    messageCount: count,
    toolCallCount: 0,
    updatedAt: "2026-06-26T10:00:00.000Z",
  },
  messages: Array.from({ length: count }, (_, i) => ({
    sessionId,
    seq: i + 1,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `message ${i + 1}`,
    projectKey: "p",
    contentHash: `hash-${i + 1}`,
  })) as MappedSession["messages"],
  toolCalls: [],
});

// A LanceDb that drops the last `getDrop()` rows of every upsert — a deterministic
// stand-in for the silent under-write (mergeInsert reporting success while fewer
// rows than requested actually landed).
const lossyLanceLayer = (dataDir: string, getDrop: () => number) =>
  Layer.effect(
    LanceDb,
    Effect.map(LanceDb, (real) =>
      LanceDb.make({
        ...real,
        upsertMessageRows: (req) => {
          const drop = getDrop();
          if (drop <= 0) return real.upsertMessageRows(req);
          return real.upsertMessageRows({ ...req, rows: req.rows.slice(0, Math.max(0, req.rows.length - drop)) });
        },
      }),
    ),
  ).pipe(Layer.provide(makeLanceDbLayer({ dataDir })));

describe("diffPairs (content-aware key diff)", () => {
  test("missing keys are expected-but-absent", () => {
    const delta = diffPairs(
      "s",
      "messages",
      new Map([["k1", "h1"], ["k2", "h2"], ["k3", "h3"]]),
      new Map([["k1", "h1"], ["k2", "h2"]]),
    );
    expect(delta.missingKeys).toEqual(["k3"]);
    expect(delta.staleKeys).toEqual([]);
    expect(delta.extraKeys).toEqual([]);
    expect(delta.converged).toBe(false);
  });

  test("a re-keyed row (same key, different content) is stale — NOT converged (content witness)", () => {
    const delta = diffPairs("s", "messages", new Map([["k1", "newhash"]]), new Map([["k1", "oldhash"]]));
    expect(delta.staleKeys).toEqual(["k1"]);
    expect(delta.missingKeys).toEqual([]);
    expect(delta.structural).toBe(true);
    expect(delta.converged).toBe(false);
  });

  test("present-but-unexpected keys are extra/structural", () => {
    const delta = diffPairs("s", "messages", new Map([["k1", "h1"]]), new Map([["k1", "h1"], ["orphan", "h9"]]));
    expect(delta.extraKeys).toEqual(["orphan"]);
    expect(delta.structural).toBe(true);
  });

  test("identical pairs converge", () => {
    const pairs = new Map([["k1", "h1"], ["k2", "h2"]]);
    const delta = diffPairs("s", "messages", pairs, new Map(pairs));
    expect(delta.converged).toBe(true);
    expect(delta.structural).toBe(false);
  });
});

describe("verifyIndexed", () => {
  // T0 — the headline. Reproduce the 27-of-29 under-write (here 5 rows, 2 dropped),
  // assert it surfaces as Divergent, is NEVER stamped, lands in the ledger, and
  // auto-heals to Converged + stamped on a full re-index.
  test("a short write is Divergent + unstamped + ledgered, and auto-heals on full re-index", async () => {
    let drop = 0;
    const sqlite = join(tempDir(), "quasar.sqlite");
    const lance = join(tempDir(), "search.lance");
    const dataLayer = Layer.mergeAll(makeLocalStoreLayer(sqlite), lossyLanceLayer(lance, () => drop));
    const searchLayer = DerivedSearchLive.pipe(Layer.provide(dataLayer));
    const runtime = ManagedRuntime.make(Layer.mergeAll(dataLayer, searchLayer));
    try {
      await runtime.runPromise(Effect.flatMap(LocalStore, (store) => store.upsertSession(session("s1", 5))));

      // Short write: the index run reports success while 2 rows never land.
      drop = 2;
      const failed = await runtime.runPromise(Effect.flatMap(DerivedSearch, (d) => Effect.either(d.indexSession("s1"))));
      expect(failed._tag).toBe("Left"); // IndexDivergent — the stamp is unreachable

      const divergent = await runtime.runPromise(verifyIndexed("s1"));
      expect(divergent._tag).toBe("Divergent");

      // Unstamped: indexed_at stays NULL → the session is still stale.
      const staleAfterShort = await runtime.runPromise(Effect.flatMap(LocalStore, (s) => s.countStaleIndexSessions()));
      expect(staleAfterShort).toBe(1);

      // The divergence is recorded with the exact missing count.
      const aggShort = await runtime.runPromise(Effect.flatMap(LocalStore, (s) => s.divergenceAggregate));
      expect(aggShort.sessions).toBe(1);
      expect(aggShort.missing).toBeGreaterThanOrEqual(2);

      // Heal: a full re-index writes every row, verifies, and only now stamps.
      drop = 0;
      await runtime.runPromise(Effect.flatMap(DerivedSearch, (d) => d.indexSession("s1")));

      const converged = await runtime.runPromise(verifyIndexed("s1"));
      expect(converged._tag).toBe("Converged");

      const staleAfterHeal = await runtime.runPromise(Effect.flatMap(LocalStore, (s) => s.countStaleIndexSessions()));
      expect(staleAfterHeal).toBe(0);
      const aggHeal = await runtime.runPromise(Effect.flatMap(LocalStore, (s) => s.divergenceAggregate));
      expect(aggHeal.sessions).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  test("a session with no searchable rows is NeverIndexed, never stamped", async () => {
    const sqlite = join(tempDir(), "quasar.sqlite");
    const lance = join(tempDir(), "search.lance");
    const dataLayer = Layer.mergeAll(makeLocalStoreLayer(sqlite), makeLanceDbLayer({ dataDir: lance }));
    const runtime = ManagedRuntime.make(dataLayer);
    try {
      await runtime.runPromise(Effect.flatMap(LocalStore, (store) => store.upsertSession(session("empty", 0))));
      const state = await runtime.runPromise(verifyIndexed("empty"));
      expect(state._tag).toBe("NeverIndexed");
    } finally {
      await runtime.dispose();
    }
  });
});
