import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer } from "@skastr0/quasar-search";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import type { MappedSession } from "../src/model";
import { DerivedSearch, DerivedSearchLive } from "../src/search";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-local-search-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mappedSession = (messages: MappedSession["messages"]): MappedSession => ({
  project: { projectKey: "project-a", displayName: "Project A", rawPath: "/tmp/project-a" },
  session: {
    sessionId: "session-a",
    projectKey: "project-a",
    provider: "codex",
    agentName: "codex",
    title: "Search fixture",
    startedAt: "2026-06-18T10:00:00.000Z",
    updatedAt: "2026-06-18T10:01:00.000Z",
    sourcePath: "/history/session-a.jsonl",
    sourceFingerprint: `fingerprint-${messages.length}`,
    messageCount: messages.length,
    toolCallCount: 0,
  },
  messages,
  toolCalls: [],
});

const message = (seq: number, text: string): MappedSession["messages"][number] => ({
  sessionId: "session-a",
  seq,
  role: seq === 1 ? "user" : "assistant",
  text,
  ts: `2026-06-18T10:0${seq}:00.000Z`,
  projectKey: "project-a",
  contentHash: `hash-${seq}-${text.replaceAll(" ", "-")}`,
});

const longText = () => "oversized message memory\n".repeat(3_000);

const withSearch = <A>(run: Effect.Effect<A, unknown, LocalStore | LanceDb | DerivedSearch>) => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const lance = join(tempDir(), "search.lance");
  const dataLayer = Layer.mergeAll(
    makeLocalStoreLayer(sqlite),
    makeLanceDbLayer({ dataDir: lance }),
  );
  const searchLayer = DerivedSearchLive.pipe(Layer.provide(dataLayer));
  return Effect.runPromise(
    run.pipe(Effect.provide(Layer.merge(dataLayer, searchLayer))),
  );
};

describe("DerivedSearch", () => {
  test("upserts SQLite-derived message rows and reports stats", async () => {
    const [report, stats] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal"), message(2, "beta shell") ]));
        const report = yield* derived.indexSession("session-a");
        const stats = yield* derived.stats;
        return [report, stats] as const;
      }),
    );

    expect(report).toEqual({
      sessionId: "session-a",
      rowsUpserted: 2,
      semanticRowsUpserted: 2,
      orphansDeleted: 0,
    });
    expect(stats.rowCount).toBe(2);
  });

  test("deletes search rows no longer present in SQLite truth", async () => {
    const [first, second, stats] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal"), message(2, "beta shell") ]));
        const first = yield* derived.indexSession("session-a");
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal") ]));
        const second = yield* derived.indexSession("session-a");
        const stats = yield* derived.stats;
        return [first, second, stats] as const;
      }),
    );

    expect(first.rowsUpserted).toBe(2);
    expect(second).toEqual({
      sessionId: "session-a",
      rowsUpserted: 1,
      semanticRowsUpserted: 1,
      orphansDeleted: 1,
    });
    expect(stats.rowCount).toBe(1);
  });

  test("keeps oversized messages semantic-eligible", async () => {
    const [report, hits, rows] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const evidence = message(2, longText());
        yield* store.upsertSession(mappedSession([message(1, "small decision memory"), evidence]));
        const report = yield* derived.indexSession("session-a");
        yield* derived.createLexicalIndex;
        const hits = yield* derived.lexicalSearch({ query: "oversized", limit: 10 });
        const search = yield* LanceDb;
        const rows = yield* search.readMessageRowsBySession({ sessionId: "session-a", select: ["contentHash"] });
        return [report, hits, rows] as const;
      }),
    );

    expect(report).toMatchObject({ rowsUpserted: 2, semanticRowsUpserted: 2 });
    expect(hits.map((hit) => hit.row.text)).toEqual([longText()]);
    expect(rows.map((row) => row.contentHash)).toContain("unembedded:hash-1-small-decision-memory");
    expect(rows.some((row) => String(row.contentHash).startsWith("unembedded:hash-2-oversized-message-memory"))).toBe(true);
  });

  test("lexical search works after explicit index creation", async () => {
    const hits = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal"), message(2, "beta shell") ]));
        yield* derived.indexSession("session-a");
        yield* derived.createLexicalIndex;
        return yield* derived.lexicalSearch({ query: "terminal", limit: 10 });
      }),
    );

    expect(hits.map((hit) => hit.row.text)).toEqual(["alpha terminal"]);
  });

  test("stats expose missing explicit indexes before maintenance creates them", async () => {
    const [before, after] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal") ]));
        yield* derived.indexSession("session-a");
        const before = yield* derived.stats;
        yield* derived.createLexicalIndex;
        const after = yield* derived.stats;
        return [before, after] as const;
      }),
    );

    expect(before.indices.map((index) => index.name)).not.toContain("text_idx");
    expect(after.indices.map((index) => index.name)).toContain("text_idx");
  });
});
